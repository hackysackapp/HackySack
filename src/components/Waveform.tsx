import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import logoUrl from '../assets/logo.webp';

interface WaveformProps {
  stream: MediaStream | null;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  alpha: number;
  decay: number;
}

export function Waveform({ stream }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nativeAmpRef = useRef<number>(0);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    // Listen to native WASAPI audio events from Rust (mic + speaker output)
    listen<number>("audio-level", (event) => {
      if (typeof event.payload === "number") {
        nativeAmpRef.current = Math.max(nativeAmpRef.current, event.payload);
      }
    }).then(fn => { unlistenFn = fn; });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Preload Hackey Sack logo image
    const logoImg = new Image();
    logoImg.src = logoUrl;

    const rect = canvas.parentElement?.getBoundingClientRect();
    canvas.width = rect?.width || 300;
    canvas.height = rect?.height || 85;

    let analyser: AnalyserNode | null = null;
    let dataArray: Uint8Array | null = null;

    if (stream) {
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);
        dataArray = new Uint8Array(analyser.frequencyBinCount);
      } catch (e) {
        console.warn("Web Audio context error:", e);
      }
    }

    // Animation physics & particle state
    let phase = 0;
    let rotationAngle = 0;
    let smoothedAmp = 0;
    let particles: Particle[] = [];
    const particleColors = ['#a855f7', '#06b6d4', '#ec4899', '#3b82f6', '#10b981'];

    const draw = () => {
      try {
        animationRef.current = requestAnimationFrame(draw);

        let micRms = 0;
        if (analyser && dataArray) {
          analyser.getByteTimeDomainData(dataArray as any);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const val = (dataArray[i] - 128) / 128.0;
            sum += val * val;
          }
          micRms = Math.sqrt(sum / dataArray.length);
        }

        // Combine mic RMS and WASAPI speaker loopback amplitude
        let nativeAmp = nativeAmpRef.current;
        nativeAmpRef.current *= 0.88; // Smooth decay

        const targetAmp = Math.min(1, Math.max(micRms * 6.0, nativeAmp * 7.5));
        smoothedAmp = smoothedAmp * 0.7 + targetAmp * 0.3;

        const w = canvas.width;
        const h = canvas.height;
        if (w <= 0 || h <= 0) return;

        // Clear canvas with subtle trail
        ctx.clearRect(0, 0, w, h);

        const floorY = h - 12;
        const ballRadius = 12;
        const maxJump = h - 28;

        // Advance bounce phase
        const speed = 0.07 + smoothedAmp * 0.12;
        phase += speed;

        // Calculate altitude using absolute sine wave (bouncing trajectory)
        const bounceFactor = Math.abs(Math.sin(phase));
        const currentJumpHeight = 12 + smoothedAmp * maxJump;
        const ballY = floorY - ballRadius - (bounceFactor * currentJumpHeight);

        // Gentle lateral sway (hackey sack juggling motion)
        const swayWidth = 15 + smoothedAmp * 40;
        const ballX = (w / 2) + Math.sin(phase * 0.45) * swayWidth;

        // Spin angle speeds up with volume
        rotationAngle += 0.03 + smoothedAmp * 0.18;

        // 1. Draw Audio Frequency Floor Line
        ctx.beginPath();
        ctx.moveTo(0, floorY);
        const segmentWidth = w / 32;
        for (let i = 0; i <= 32; i++) {
          const x = i * segmentWidth;
          const distToBall = Math.abs(x - ballX);
          const bump = Math.max(0, 1 - distToBall / 60) * (bounceFactor < 0.15 ? smoothedAmp * 12 : 3);
          const waveY = floorY + Math.sin(i * 0.5 + phase * 2) * (smoothedAmp * 4) + bump;
          if (i === 0) ctx.moveTo(x, waveY);
          else ctx.lineTo(x, waveY);
        }
        ctx.strokeStyle = `rgba(168, 85, 247, ${0.3 + smoothedAmp * 0.5})`;
        ctx.lineWidth = 2;
        ctx.stroke();

        // 2. Draw Floor Shadow
        const altitude = floorY - ballRadius - ballY;
        const normAlt = Math.min(1, altitude / (maxJump + 12));
        const shadowRadiusX = ballRadius * (1 - normAlt * 0.5);
        const shadowRadiusY = 4 * (1 - normAlt * 0.5);
        const shadowOpacity = 0.45 * (1 - normAlt * 0.7);

        ctx.save();
        ctx.beginPath();
        ctx.ellipse(ballX, floorY + 2, shadowRadiusX, shadowRadiusY, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 0, 0, ${shadowOpacity})`;
        ctx.fill();
        ctx.restore();

        // 3. Spawn Particles at Bottom Bounce / Impact
        if (bounceFactor < 0.12 && Math.random() < 0.6) {
          for (let p = 0; p < 2; p++) {
            particles.push({
              x: ballX + (Math.random() - 0.5) * 16,
              y: floorY,
              vx: (Math.random() - 0.5) * 3,
              vy: -Math.random() * 2.5 - 1,
              size: Math.random() * 3.5 + 2,
              color: particleColors[Math.floor(Math.random() * particleColors.length)],
              alpha: 0.9,
              decay: Math.random() * 0.03 + 0.02
            });
          }
        }

        // 4. Render & Update Particles
        for (let i = particles.length - 1; i >= 0; i--) {
          const pt = particles[i];
          pt.x += pt.vx;
          pt.y += pt.vy;
          pt.alpha -= pt.decay;

          if (pt.alpha <= 0) {
            particles.splice(i, 1);
            continue;
          }

          ctx.save();
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
          ctx.fillStyle = pt.color;
          ctx.globalAlpha = pt.alpha;
          ctx.shadowColor = pt.color;
          ctx.shadowBlur = 6;
          ctx.fill();
          ctx.restore();
        }

        // 5. Draw Bouncing Hackey Sack Ball
        ctx.save();
        ctx.translate(ballX, ballY);
        ctx.rotate(rotationAngle);

        // Squish and stretch on bounce impact vs peak
        let scaleX = 1;
        let scaleY = 1;
        if (bounceFactor < 0.15) {
          // Impact squish
          const squish = (0.15 - bounceFactor) / 0.15;
          scaleX = 1 + squish * 0.25;
          scaleY = 1 - squish * 0.25;
        } else if (bounceFactor > 0.85) {
          // Peak stretch
          scaleX = 0.92;
          scaleY = 1.08;
        }
        ctx.scale(scaleX, scaleY);

        // Glow ring around hackey sack
        const glowRadius = ballRadius + 4 + smoothedAmp * 8;
        const glowGrad = ctx.createRadialGradient(0, 0, ballRadius * 0.5, 0, 0, glowRadius);
        glowGrad.addColorStop(0, `rgba(168, 85, 247, ${0.4 + smoothedAmp * 0.4})`);
        glowGrad.addColorStop(1, 'rgba(6, 182, 212, 0)');

        ctx.beginPath();
        ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
        ctx.fillStyle = glowGrad;
        ctx.fill();

        // Draw Hackey Sack logo image
        if (logoImg.complete && logoImg.naturalWidth !== 0) {
          ctx.beginPath();
          ctx.arc(0, 0, ballRadius, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(logoImg, -ballRadius, -ballRadius, ballRadius * 2, ballRadius * 2);
        } else {
          // Fallback hackey sack gradient orb if image is loading
          const fallbackGrad = ctx.createRadialGradient(-4, -4, 2, 0, 0, ballRadius);
          fallbackGrad.addColorStop(0, '#a855f7');
          fallbackGrad.addColorStop(1, '#06b6d4');
          ctx.beginPath();
          ctx.arc(0, 0, ballRadius, 0, Math.PI * 2);
          ctx.fillStyle = fallbackGrad;
          ctx.fill();
        }

        // Sleek subtle border around sack
        ctx.beginPath();
        ctx.arc(0, 0, ballRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 + smoothedAmp * 0.4})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.restore();

      } catch (e) {
        console.error("Waveform animation draw error:", e);
      }
    };

    draw();

    return () => {
      cancelAnimationFrame(animationRef.current);
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch (e) {}
      }
    };
  }, [stream]);

  return (
    <div style={{
        width: '140px',
        height: '60px',
        background: 'rgba(10, 11, 15, 0.45)',
        borderRadius: '8px',
        overflow: 'hidden',
        border: '1px solid rgba(168, 85, 247, 0.2)',
        boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.3), 0 0 15px rgba(124, 58, 237, 0.15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        flexShrink: 0
    }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}
