
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isSpeaking: boolean;
  isListening: boolean;
  isActive: boolean;
}

const Visualizer: React.FC<VisualizerProps> = ({ isSpeaking, isListening, isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrame: number;
    let time = 0;

    const render = () => {
      time += 0.04;
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const baseRadius = isActive ? 60 : 50;
      
      // Outer Fading Rings
      if (isActive) {
        for (let i = 1; i <= 3; i++) {
          const opacity = (0.2 / i) * (Math.sin(time * 1.5 - i * 0.5) * 0.5 + 0.8);
          ctx.strokeStyle = `rgba(45, 212, 191, ${opacity})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(centerX, centerY, baseRadius * (1 + i * 0.5), 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // The Main Glowing Center
      const coreRadius = baseRadius * (1 + (isSpeaking ? Math.sin(time * 8) * 0.15 : isListening ? Math.sin(time * 4) * 0.05 : 0));
      const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, coreRadius);
      
      if (isActive) {
        gradient.addColorStop(0, '#5eead4');
        gradient.addColorStop(0.6, '#14b8a6');
        gradient.addColorStop(1, 'rgba(20, 184, 166, 0)');
      } else {
        gradient.addColorStop(0, '#134e4a');
        gradient.addColorStop(1, 'rgba(19, 78, 74, 0)');
      }

      ctx.beginPath();
      ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();

      // Core shadow/glow
      ctx.shadowBlur = isActive ? 30 : 5;
      ctx.shadowColor = '#14b8a6';
      ctx.fill();
      ctx.shadowBlur = 0;

      animationFrame = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrame);
  }, [isSpeaking, isListening, isActive]);

  return (
    <div className="relative flex items-center justify-center w-full h-80">
      <canvas 
        ref={canvasRef} 
        width={400} 
        height={400} 
        className="max-w-full h-auto drop-shadow-[0_0_20px_rgba(20,184,166,0.3)]"
      />
    </div>
  );
};

export default Visualizer;
