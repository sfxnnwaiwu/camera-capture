import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, output, signal, viewChild } from '@angular/core';

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

@Component({
    selector: 'app-root',
    templateUrl: './app.html',
    styleUrl: './app.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: true,
})
export class App implements AfterViewInit {
    // Output event to emit captured image
    imageCapture = output<string>();

    // Image configuration for backend upload
    private readonly UPLOAD_IMAGE_WIDTH = 800; // Optimal width for backend
    private readonly UPLOAD_IMAGE_HEIGHT = 600; // Optimal height for backend
    private readonly IMAGE_QUALITY = 0.85; // JPEG quality (0.0 - 1.0)

    videoEl = viewChild.required<ElementRef<HTMLVideoElement>>('video');
    canvasEl = viewChild.required<ElementRef<HTMLCanvasElement>>('overlay');

    // Verification states
    faceInRange = signal(false);
    blinkDetected = signal(false);
    headTiltedUp = signal(false);
    headTiltedDown = signal(false);
    blinkCompleted = signal(false);
    upTiltCompleted = signal(false);
    downTiltCompleted = signal(false);
    imageCaptured = signal(false);
    verificationComplete = signal(false);

    // New: Verification workflow control
    verificationStarted = signal(false);
    canStartVerification = signal(false);

    status = signal('Initializing...');

    private ctx!: CanvasRenderingContext2D;
    private landmarker!: FaceLandmarker;
    private stream?: MediaStream;
    private capturedImageData?: string;

    ngAfterViewInit() {
        this.initializeCamera();
    }

    private async initializeCamera() {
        try {
            this.status.set('Requesting camera permission...');
            console.log('Requesting camera permission...');
            // 1. Start video
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user' },
            });
            console.log('Camera permission granted, setting up video...');
            this.status.set('Setting up video...');

            const videoElement = this.videoEl().nativeElement;
            videoElement.srcObject = this.stream;

            await videoElement.play();
            console.log('Video started successfully');
            this.status.set('Video playing');

            // 2. Init canvas context
            this.ctx = this.canvasEl().nativeElement.getContext('2d')!;
            console.log('Canvas context initialized');

            // Start spotlight video display first
            this.spotlightVideoLoop();

            // Wait a bit for video to be ready before starting face detection
            setTimeout(() => {
                this.loadFaceLandmarker();
            }, 1000);
        } catch (error) {
            console.error('Error initializing camera:', error);
            this.status.set('Camera error: ' + (error instanceof Error ? error.message : 'Unknown error'));
            // Show error message to user
            this.showErrorMessage('Camera access denied or not available');
        }
    }

    private async loadFaceLandmarker() {
        try {
            this.status.set('Loading face detection...');
            console.log('Loading face landmarker...');
            // 3. Load Face Landmarker
            const vision = await FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm`);

            this.landmarker = await FaceLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                },
                runningMode: 'VIDEO',
                numFaces: 1,
            });

            console.log('Face landmarker loaded successfully');
            this.status.set('Position your face in the frame and click "Capture Image"');
            this.canStartVerification.set(true);

            // 4. Start spotlight video display loop
            this.spotlightVideoLoop();
        } catch (error) {
            console.error('Error loading face landmarker:', error);
            this.status.set('Face detection failed, video only mode');
            // Continue with simple loop without face detection
        }
    }

    private showErrorMessage(message: string) {
        const canvas = this.canvasEl().nativeElement;
        canvas.width = 640;
        canvas.height = 480;

        this.ctx.fillStyle = 'black';
        this.ctx.fillRect(0, 0, canvas.width, canvas.height);

        this.ctx.fillStyle = 'white';
        this.ctx.font = '20px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(message, canvas.width / 2, canvas.height / 2);
    }

    private spotlightVideoLoop() {
        // Show video with spotlight overlay AND face detection for positioning
        const video = this.videoEl().nativeElement;
        const canvas = this.canvasEl().nativeElement;

        if (video.videoWidth === 0 || video.videoHeight === 0) {
            requestAnimationFrame(() => this.spotlightVideoLoop());
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        // Create spotlight overlay
        this.ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Create completely opaque overlay with dark blue-gray
        this.ctx.fillStyle = 'rgba(30, 45, 75, 1.0)';
        this.ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw target oval
        this.drawTargetOval(canvas);

        // Run face detection to show "in range" status (but don't track movements yet)
        this.detectFacePosition(video, canvas);

        // Continue loop unless verification has started
        if (!this.verificationStarted()) {
            requestAnimationFrame(() => this.spotlightVideoLoop());
        }
    }

    private detectFacePosition(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
        // Simple face detection just for positioning feedback (no movement tracking)
        try {
            const results = this.landmarker.detectForVideo(video, performance.now());

            if (results.faceLandmarks && results.faceLandmarks.length > 0) {
                const landmarks = results.faceLandmarks[0];

                // Check if face is in the target oval area
                const cx = canvas.width / 2;
                const cy = canvas.height / 2;
                const rx = canvas.width * 0.25;
                const ry = canvas.height * 0.35;

                // Get face center from landmarks
                const noseTip = landmarks[1];
                const faceX = noseTip.x * canvas.width;
                const faceY = noseTip.y * canvas.height;

                // Check if face is within oval bounds
                const normalizedX = (faceX - cx) / rx;
                const normalizedY = (faceY - cy) / ry;
                const inRange = normalizedX * normalizedX + normalizedY * normalizedY <= 1;

                this.faceInRange.set(inRange);

                // Draw oval border with appropriate color
                this.drawOvalBorder(cx, cy, rx, ry);
                this.drawHints(inRange, cx, cy, ry);
            } else {
                // No face detected
                this.faceInRange.set(false);
                const cx = canvas.width / 2;
                const cy = canvas.height / 2;
                const rx = canvas.width * 0.25;
                const ry = canvas.height * 0.35;

                this.drawOvalBorder(cx, cy, rx, ry);
                this.drawHints(false, cx, cy, ry);
            }
        } catch (error) {
            // If face detection fails, just show the oval without status
            console.warn('Face detection error in spotlight mode:', error);
            this.faceInRange.set(false);
        }
    }

    // Updated method to capture image first, then start verification
    captureImage() {
        if (!this.canStartVerification() || this.imageCaptured()) {
            return;
        }

        // Capture image immediately
        const video = this.videoEl().nativeElement;
        const resizedImageDataUrl = this.resizeImageForUpload(video);

        // Store the captured image for later emission
        this.capturedImageData = resizedImageDataUrl;
        this.imageCaptured.set(true);
        this.canStartVerification.set(false);

        this.status.set('Image captured! Starting verification process...');

        // Start verification automatically after a brief delay
        setTimeout(() => {
            this.startVerificationProcess();
        }, 1000);
    }

    private startVerificationProcess() {
        this.verificationStarted.set(true);
        this.status.set('Please complete the verification steps: blink and tilt your head');

        // Reset verification states (keep imageCaptured as true)
        this.faceInRange.set(false);
        this.blinkDetected.set(false);
        this.headTiltedUp.set(false);
        this.headTiltedDown.set(false);
        this.blinkCompleted.set(false);
        this.upTiltCompleted.set(false);
        this.downTiltCompleted.set(false);
        this.verificationComplete.set(false);

        // Start the verification detection loop
        this.detectLoop();
    }

    private detectLoop() {
        const video = this.videoEl().nativeElement;
        const canvas = this.canvasEl().nativeElement;

        // Stop detection if verification is complete
        if (this.verificationComplete()) {
            return;
        }

        // Only run if verification has started
        if (!this.verificationStarted()) {
            requestAnimationFrame(() => this.detectLoop());
            return;
        }

        // Check if video is ready
        if (video.videoWidth === 0 || video.videoHeight === 0) {
            requestAnimationFrame(() => this.detectLoop());
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        this.ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Create completely opaque overlay with dark blue-gray (no transparency)
        this.ctx.fillStyle = 'rgba(30, 45, 75, 1.0)';
        this.ctx.fillRect(0, 0, canvas.width, canvas.height);

        this.drawTargetOval(canvas);
        this.processFaceDetection(video, canvas);

        requestAnimationFrame(() => this.detectLoop());
    }

    private drawTargetOval(canvas: HTMLCanvasElement) {
        // Draw oval "target" in center
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const rx = canvas.width * 0.25;
        const ry = canvas.height * 0.35;

        // Create the oval cutout (transparent area)
        this.ctx.save();
        this.ctx.globalCompositeOperation = 'destination-out';
        this.ctx.beginPath();
        this.ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
        this.ctx.fill();
        this.ctx.restore();

        // Add a subtle gradient border around the oval
        this.ctx.save();
        this.ctx.globalCompositeOperation = 'source-over';
        const gradient = this.ctx.createRadialGradient(cx, cy, rx * 0.9, cx, cy, rx * 1.1);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0.1)');

        this.ctx.beginPath();
        this.ctx.ellipse(cx, cy, rx * 1.05, ry * 1.05, 0, 0, 2 * Math.PI);
        this.ctx.fillStyle = gradient;
        this.ctx.fill();
        this.ctx.restore();
    }

    private processFaceDetection(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
        if (!this.landmarker) return;

        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const rx = canvas.width * 0.25;
        const ry = canvas.height * 0.35;

        // Run face landmark detection
        const results = this.landmarker.detectForVideo(video, performance.now());

        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
            const landmarks = results.faceLandmarks[0];

            // Get key facial landmarks for positioning
            const noseTip = landmarks[1]; // Nose tip - most stable reference point
            const leftCheek = landmarks[234]; // Left cheek point
            const rightCheek = landmarks[454]; // Right cheek point
            const leftEye = landmarks[33]; // Left eye center
            const rightEye = landmarks[263]; // Right eye center

            // Calculate face center using nose and eyes (more stable during tilting)
            const faceCenterX = noseTip.x * canvas.width;
            const faceCenterY = ((leftEye.y + rightEye.y) / 2) * canvas.height;

            // Calculate face width (distance between cheeks)
            const faceWidth = Math.abs((rightCheek.x - leftCheek.x) * canvas.width);

            // More lenient positioning check that accommodates head tilting
            const horizontalTolerance = rx * 0.7; // 70% of oval width
            const verticalTolerance = ry * 0.7; // 70% of oval height

            // Check if face center is reasonably within oval
            const horizontallyInRange = Math.abs(faceCenterX - cx) < horizontalTolerance;
            const verticallyInRange = Math.abs(faceCenterY - cy) < verticalTolerance;

            // Check if face size is appropriate (not too close or too far)
            const expectedFaceWidth = rx * 1.2; // Expected face width relative to oval
            const sizeRatio = faceWidth / expectedFaceWidth;
            const appropriateSize = sizeRatio > 0.6 && sizeRatio < 1.8; // Allow 60%-180% range

            const inRange = horizontallyInRange && verticallyInRange && appropriateSize;

            this.faceInRange.set(inRange);

            // Face positioning is tracked but image capture is manual

            // Blink detection (naive): compare vertical eye distance
            const leftEyeTop = landmarks[159]; // top of left eye
            const leftEyeBottom = landmarks[145]; // bottom of left eye
            const eyeOpen = Math.abs(leftEyeBottom.y - leftEyeTop.y);

            const currentBlink = eyeOpen < 0.015;
            this.blinkDetected.set(currentBlink);

            // Mark blink as completed once detected
            if (currentBlink) {
                this.blinkCompleted.set(true);
            }

            // Head turning and tilting detection using facial landmarks
            this.detectHeadMovements(landmarks, canvas.width, canvas.height);

            // Check if verification is complete
            const allTiltsComplete = this.upTiltCompleted() && this.downTiltCompleted();
            const allActionsComplete = this.blinkCompleted() && allTiltsComplete;

            if (allActionsComplete && !this.verificationComplete()) {
                this.completeVerification();
            }

            this.drawOvalBorder(cx, cy, rx, ry);
            this.drawHints(inRange, cx, cy, ry);
        } else {
            // Reset all detection signals when no face is detected
            this.faceInRange.set(false);
            this.blinkDetected.set(false);
            this.headTiltedUp.set(false);
            this.headTiltedDown.set(false);
        }
    }

    private detectHeadMovements(landmarks: any[], canvasWidth: number, canvasHeight: number) {
        // Use multiple reference points for more accurate head tilt detection
        const noseTip = landmarks[1]; // Nose tip
        const foreheadCenter = landmarks[9]; // Top of forehead
        const chinBottom = landmarks[175]; // Bottom of chin
        const leftEye = landmarks[33]; // Left eye corner
        const rightEye = landmarks[263]; // Right eye corner
        const upperLip = landmarks[13]; // Upper lip center
        const lowerLip = landmarks[14]; // Lower lip center

        // === IMPROVED HEAD TILTING DETECTION (UP/DOWN) ===
        // Use multiple facial features to create a more robust detection system

        // Method 1: Eye-to-lip distance ratio
        const eyeCenterY = ((leftEye.y + rightEye.y) / 2) * canvasHeight;
        const lipCenterY = ((upperLip.y + lowerLip.y) / 2) * canvasHeight;
        const eyeLipDistance = lipCenterY - eyeCenterY;

        // Method 2: Nose-to-chin vs forehead-to-nose ratios
        const foreheadY = foreheadCenter.y * canvasHeight;
        const noseTipY = noseTip.y * canvasHeight;
        const chinY = chinBottom.y * canvasHeight;

        const foreheadToNose = noseTipY - foreheadY;
        const noseToChin = chinY - noseTipY;
        const ratio = foreheadToNose / (noseToChin + 0.1); // Add small value to prevent division by zero

        // Method 3: Face aspect analysis
        const faceHeight = Math.abs(chinY - foreheadY);
        const faceCenterY = (foreheadY + chinY) / 2;
        const noseVerticalOffset = noseTipY - faceCenterY;
        const normalizedVerticalOffset = noseVerticalOffset / (faceHeight * 0.25);

        // Combined detection with properly calibrated thresholds
        const baseRatio = 0.9; // Normal ratio when looking straight (adjusted)
        const ratioThreshold = 0.25; // Less sensitive threshold for ratio changes
        const offsetThreshold = 0.5; // More conservative threshold for nose movement

        // More conservative detection logic - require multiple indicators
        const tiltedUp =
            normalizedVerticalOffset < -offsetThreshold && // Strong nose movement up
            (ratio < baseRatio - ratioThreshold || eyeLipDistance < faceHeight * 0.16);

        const tiltedDown =
            normalizedVerticalOffset > offsetThreshold && // Strong nose movement down
            (ratio > baseRatio + ratioThreshold || eyeLipDistance > faceHeight * 0.28);

        this.headTiltedUp.set(tiltedUp);
        this.headTiltedDown.set(tiltedDown); // Mark tilts as completed once detected
        if (tiltedUp) {
            this.upTiltCompleted.set(true);
        }
        if (tiltedDown) {
            this.downTiltCompleted.set(true);
        }
    }
    private drawOvalBorder(cx: number, cy: number, rx: number, ry: number) {
        // Draw oval border
        this.ctx.beginPath();
        this.ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
        this.ctx.lineWidth = 5;

        // Determine stroke color based on verification progress
        let strokeColor = 'red'; // Default: face not in range
        if (this.faceInRange()) {
            // Face is properly positioned
            const allTiltsComplete = this.upTiltCompleted() && this.downTiltCompleted();
            const allActionsComplete = this.blinkCompleted() && allTiltsComplete;

            if (allActionsComplete) {
                strokeColor = 'limegreen'; // All verification complete
            } else if (this.blinkCompleted()) {
                strokeColor = 'cyan'; // Blink done, working on tilts
            } else {
                strokeColor = 'orange'; // Face positioned, need to blink
            }
        }
        this.ctx.strokeStyle = strokeColor;
        this.ctx.stroke();
    }

    private drawHints(inRange: boolean, cx: number, cy: number, ry: number) {
        this.ctx.font = '18px sans-serif';
        this.ctx.textAlign = 'center';

        // Hint if not aligned
        if (!inRange) {
            this.ctx.fillStyle = 'yellow';
            this.ctx.fillText('Center your face fully in the oval', cx, cy - ry - 30);
            return;
        }

        // Instructions for face verification steps
        let instructionY = cy + ry + 40;

        // Check completion status
        const allTiltsComplete = this.upTiltCompleted() && this.downTiltCompleted();
        const allActionsComplete = this.blinkCompleted() && allTiltsComplete;

        if (this.verificationComplete()) {
            this.ctx.fillStyle = 'limegreen';
            this.ctx.fillText('✅ Verification Complete! Image Processed.', cx, instructionY);
        } else if (!this.imageCaptured()) {
            this.ctx.fillStyle = 'cyan';
            this.ctx.fillText('📸 Position looks good! Capturing image...', cx, instructionY);
        } else if (!this.blinkCompleted()) {
            this.ctx.fillStyle = 'orange';
            this.ctx.fillText('Image captured! Now blink to verify', cx, instructionY);
        } else if (!allTiltsComplete) {
            this.ctx.fillStyle = 'lightblue';
            if (!this.upTiltCompleted() && !this.downTiltCompleted()) {
                this.ctx.fillText('Great! Now tilt your head up, then down', cx, instructionY);
            } else if (this.upTiltCompleted() && !this.downTiltCompleted()) {
                this.ctx.fillText('Excellent! Now tilt down', cx, instructionY);
            } else if (this.downTiltCompleted() && !this.upTiltCompleted()) {
                this.ctx.fillText('Excellent! Now tilt up', cx, instructionY);
            }
        } else if (allActionsComplete) {
            this.ctx.fillStyle = 'limegreen';
            this.ctx.fillText('🎉 Processing verification...', cx, instructionY);
        }
    }

    private completeVerification() {
        // Mark verification as complete
        this.verificationComplete.set(true);
        this.status.set('Verification complete! Processing captured image...');

        // Emit the previously captured and optimized image
        if (this.capturedImageData) {
            this.imageCapture.emit(this.capturedImageData);
        }

        // Update status and stop video stream
        this.status.set('Verification complete! Stopping camera...');
        this.stopVideoStream();

        console.log('Verification complete! Captured image emitted and camera stopped.');

        // Final status update
        setTimeout(() => {
            this.status.set('Verification complete. Camera stopped.');
        }, 1000);
    }

    private stopVideoStream() {
        if (this.stream) {
            // Stop all tracks in the stream
            this.stream.getTracks().forEach((track) => {
                track.stop();
                console.log('Video track stopped:', track.kind);
            });

            // Clear video source
            const videoElement = this.videoEl().nativeElement;
            videoElement.srcObject = null;

            console.log('Video stream completely stopped');
        }
    }

    private resizeImageForUpload(video: HTMLVideoElement): string {
        // Create canvas for the original capture
        const sourceCanvas = document.createElement('canvas');
        const sourceCtx = sourceCanvas.getContext('2d')!;

        // Set source canvas to video dimensions
        sourceCanvas.width = video.videoWidth;
        sourceCanvas.height = video.videoHeight;

        // Draw the current video frame
        sourceCtx.drawImage(video, 0, 0, sourceCanvas.width, sourceCanvas.height);

        // Create target canvas with optimal dimensions for backend
        const targetCanvas = document.createElement('canvas');
        const targetCtx = targetCanvas.getContext('2d')!;

        targetCanvas.width = this.UPLOAD_IMAGE_WIDTH;
        targetCanvas.height = this.UPLOAD_IMAGE_HEIGHT;

        // Calculate scaling to maintain aspect ratio
        const sourceAspectRatio = sourceCanvas.width / sourceCanvas.height;
        const targetAspectRatio = targetCanvas.width / targetCanvas.height;

        let drawWidth: number;
        let drawHeight: number;
        let offsetX = 0;
        let offsetY = 0;

        if (sourceAspectRatio > targetAspectRatio) {
            // Source is wider - fit to height
            drawHeight = targetCanvas.height;
            drawWidth = drawHeight * sourceAspectRatio;
            offsetX = (targetCanvas.width - drawWidth) / 2;
        } else {
            // Source is taller - fit to width
            drawWidth = targetCanvas.width;
            drawHeight = drawWidth / sourceAspectRatio;
            offsetY = (targetCanvas.height - drawHeight) / 2;
        }

        // Fill background with white (for areas not covered by image)
        targetCtx.fillStyle = '#ffffff';
        targetCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

        // Draw resized image
        targetCtx.drawImage(sourceCanvas, offsetX, offsetY, drawWidth, drawHeight);

        // Convert to optimized JPEG
        const optimizedImageDataUrl = targetCanvas.toDataURL('image/jpeg', this.IMAGE_QUALITY);

        console.log(`Image resized from ${sourceCanvas.width}x${sourceCanvas.height} to ${targetCanvas.width}x${targetCanvas.height}`);
        console.log(
            `Image size reduced by approximately ${Math.round((1 - optimizedImageDataUrl.length / sourceCanvas.toDataURL('image/jpeg', 0.9).length) * 100)}%`
        );

        return optimizedImageDataUrl;
    }
}
