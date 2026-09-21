import React from 'react';

interface HaysLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
  showTagline?: boolean;
  lightText?: boolean;
  className?: string;
}

export const HaysLogo: React.FC<HaysLogoProps> = ({
  size = 'md',
  showWordmark = true,
  showTagline = true,
  lightText = true,
  className = ''
}) => {
  // Dimension settings
  const iconDimensions = {
    sm: { width: 28, height: 28 },
    md: { width: 36, height: 36 },
    lg: { width: 48, height: 48 }
  }[size];

  const titleSizes = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-2xl'
  }[size];

  const taglineSizes = {
    sm: 'text-[10px]',
    md: 'text-[11px]',
    lg: 'text-xs'
  }[size];

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {/* Exact Geometric "H" Mark based on Hays + Sons identity:
          Left vertical stem: Rich Brand Red (#C81D25)
          Right intersection: Bold Solid Black / Dark Stem & Crossbar (#111111) */}
      <svg
        width={iconDimensions.width}
        height={iconDimensions.height}
        viewBox="0 0 60 60"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0 drop-shadow-sm"
        aria-label="Hays + Sons Logo"
      >
        {/* Left vertical red pillar */}
        <rect
          x="3"
          y="4"
          width="18"
          height="52"
          rx="1.5"
          fill="#C81D25"
        />

        {/* Horizontal crossbar connecting to the right */}
        <rect
          x="21"
          y="23"
          width="36"
          height="14"
          fill={lightText ? "#FFFFFF" : "#111111"}
        />

        {/* Right vertical pillar intersecting the crossbar */}
        <rect
          x="33"
          y="11"
          width="17"
          height="38"
          rx="1.5"
          fill={lightText ? "#FFFFFF" : "#111111"}
        />
      </svg>

      {/* Wordmark and Tagline */}
      {showWordmark && (
        <div className="flex flex-col justify-center select-none leading-none">
          <div className="flex items-center">
            <span
              className={`font-black tracking-tight ${titleSizes} ${
                lightText ? 'text-white' : 'text-slate-950'
              }`}
              style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
            >
              Hays
            </span>
            <span
              className={`font-black px-0.5 ${titleSizes} text-[#C81D25]`}
              style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
            >
              +
            </span>
            <span
              className={`font-black tracking-tight ${titleSizes} ${
                lightText ? 'text-white' : 'text-slate-950'
              }`}
              style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
            >
              Sons
            </span>
          </div>

          {showTagline && (
            <div
              className={`font-medium tracking-normal mt-0.5 ${taglineSizes} ${
                lightText ? 'text-slate-300' : 'text-slate-600'
              }`}
            >
              We Do Restoration Right
            </div>
          )}
        </div>
      )}
    </div>
  );
};
