import React, { useState, useRef, useEffect, useCallback } from 'react';

interface PrivacyBlurProps {
  enabled: boolean;
  children: React.ReactNode;
}

const PrivacyBlur: React.FC<PrivacyBlurProps> = ({ enabled, children }) => {
  const [revealed, setRevealed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setRevealed(false);
      clearTimer();
    }
  }, [enabled, clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  if (!enabled) return <>{children}</>;

  const blurred = !revealed;

  const reveal = () => {
    setRevealed(true);
    clearTimer();
    timerRef.current = setTimeout(() => {
      setRevealed(false);
    }, 5000);
  };

  const handleReBlur = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearTimer();
    setRevealed(false);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div style={{ filter: blurred ? 'blur(24px)' : 'none', transition: 'filter 0.2s', width: '100%', height: '100%' }}>
        {children}
      </div>
      {blurred && (
        <div
          onClick={reveal}
          style={{
            position: 'absolute', inset: 0, cursor: 'pointer', zIndex: 10,
          }}
          title="点击取消模糊"
        />
      )}
      {revealed && (
        <div
          onClick={handleReBlur}
          style={{
            position: 'absolute', top: 4, right: 4, zIndex: 10,
            width: 24, height: 24, borderRadius: '50%',
            background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: '#fff', fontSize: 14, lineHeight: 1,
            fontWeight: 700,
          }}
          title="重新模糊"
        >
          ×
        </div>
      )}
    </div>
  );
};

export default PrivacyBlur;
