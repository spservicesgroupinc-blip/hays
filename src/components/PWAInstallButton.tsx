import React, { useState } from 'react';
import { Download, Share2, PlusSquare, X, Smartphone, CheckCircle, ShieldCheck } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'compact' | 'full' | 'banner';
  className?: string;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ 
  variant = 'compact',
  className = ''
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSModal, setShowIOSModal] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);

  // If app is already launched as a standalone PWA on home screen, hide install controls
  if (isInstalled) {
    return null;
  }

  const handleInstallClick = async () => {
    if (isInstallable) {
      setIsInstalling(true);
      try {
        await install();
      } finally {
        setIsInstalling(false);
      }
    } else if (isIOS) {
      setShowIOSModal(true);
    } else {
      // Desktop / Other browsers that haven't fired beforeinstallprompt or need browser menu
      setShowIOSModal(true);
    }
  };

  return (
    <>
      {/* 1. Compact Button (For HeaderNav) */}
      {variant === 'compact' && (
        <button
          type="button"
          onClick={handleInstallClick}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-red-600 to-[#C81D25] hover:from-red-700 hover:to-[#A8151D] text-white text-xs font-bold shadow-sm transition active:scale-95 ${className}`}
          title="Install FieldProof to your device"
        >
          <Download className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Install App</span>
          <span className="sm:hidden">Install</span>
        </button>
      )}

      {/* 2. Full Width Button (For Menus / Sidebars / Mobile Drawers) */}
      {variant === 'full' && (
        <button
          type="button"
          onClick={handleInstallClick}
          className={`w-full flex items-center justify-between p-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white transition text-xs font-bold border border-slate-700 shadow-md ${className}`}
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#C81D25] flex items-center justify-center text-white">
              <Download className="w-4 h-4" />
            </div>
            <div className="text-left">
              <div className="text-xs font-bold text-white">Download FieldProof</div>
              <div className="text-[10px] text-slate-400 font-normal">Fast 1-tap mobile & desktop access</div>
            </div>
          </div>
          <span className="text-[10px] bg-white/10 px-2 py-1 rounded-md text-slate-200">
            {isIOS ? 'iOS Setup' : 'Install'}
          </span>
        </button>
      )}

      {/* 3. Promotional Top/Bottom Banner (For Subcontractor Portal or Dashboard) */}
      {variant === 'banner' && (
        <div className={`p-3.5 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white border border-slate-700/80 shadow-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${className}`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#C81D25] flex items-center justify-center text-white shadow-inner shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-black text-white">Install FieldProof on your Phone</h4>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  OFFLINE READY
                </span>
              </div>
              <p className="text-[11px] text-slate-300 mt-0.5">
                Install as a native home-screen app for rapid photo inspections and instant job access on site.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleInstallClick}
            disabled={isInstalling}
            className="w-full sm:w-auto px-4 py-2 rounded-xl bg-[#C81D25] hover:bg-red-700 text-white text-xs font-bold shadow-md transition flex items-center justify-center gap-2 shrink-0 active:scale-95"
          >
            <Download className="w-4 h-4" />
            <span>{isIOS ? 'Add to iPhone Home Screen' : 'Install App'}</span>
          </button>
        </div>
      )}

      {/* iOS Safari / Universal Step-by-Step Installation Modal */}
      {showIOSModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl border border-slate-200 text-slate-900">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-[#C81D25] flex items-center justify-center text-white">
                  <Smartphone className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    {isIOS ? 'Install on iPhone / iPad' : 'Install FieldProof'}
                  </h3>
                  <p className="text-[10px] text-slate-500">Standalone App Installation</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowIOSModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <div className="mt-4 space-y-3.5">
                <div className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
                  <div className="w-7 h-7 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center shrink-0 mt-0.5">
                    <Share2 className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-900">1. Tap Safari's Share Icon</div>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      Tap the <strong>Share</strong> button at the bottom of your Safari screen (the square with the arrow pointing up).
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
                  <div className="w-7 h-7 rounded-lg bg-red-100 text-[#C81D25] flex items-center justify-center shrink-0 mt-0.5">
                    <PlusSquare className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-900">2. Tap "Add to Home Screen"</div>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      Scroll down in the action sheet menu and select <strong>Add to Home Screen</strong>.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-xl bg-emerald-50 border border-emerald-100">
                  <div className="w-7 h-7 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0 mt-0.5">
                    <CheckCircle className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-900">3. Tap "Add" (Top Right)</div>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      FieldProof will appear on your home screen with its own full-screen app icon!
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <p className="text-xs text-slate-600">
                  To install FieldProof on your desktop or Android device:
                </p>
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 space-y-2 text-xs text-slate-700">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[#C81D25]" />
                    <span>Click the <strong>Install</strong> icon in your browser's address bar.</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Download className="w-4 h-4 text-blue-600" />
                    <span>Or open browser menu (⋮) and select <strong>"Install FieldProof..."</strong></span>
                  </div>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowIOSModal(false)}
              className="mt-4 w-full py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-sm transition"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
};
