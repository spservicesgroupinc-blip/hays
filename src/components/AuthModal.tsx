import React, { useState } from 'react';
import { 
  User as UserIcon, 
  HardHat, 
  Building2, 
  Mail, 
  Lock, 
  X, 
  ArrowRight,
  Briefcase,
  LogOut,
  Eye,
  EyeOff,
  AlertCircle,
  Phone
} from 'lucide-react';
import { User as UserType, UserRole } from '../types';
import { HaysLogo } from './HaysLogo';
import { safeFetchJson } from '../utils/api';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserType | null;
  onLoginSuccess: (user: UserType, token: string) => void;
  onLogout: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onLoginSuccess,
  onLogout
}) => {
  const [showSwitchForm, setShowSwitchForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleDirectLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password.');
      return;
    }

    setIsLoading(true);
    setError(null);
    const { ok, data, error: fetchErr } = await safeFetchJson<{ success: boolean; user: UserType; token: string; error?: string }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password: password.trim() })
    });
    if (!ok || !data?.success) {
      setError(fetchErr || data?.error || 'Invalid credentials.');
      setIsLoading(false);
      return;
    }
    onLoginSuccess(data.user, data.token);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div 
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full border border-slate-200 overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-[#C81D25] text-white p-4 sm:p-5 flex items-center justify-between shadow-md">
          <div className="flex items-center gap-2.5">
            <HaysLogo size="sm" lightText={true} />
            <div>
              <h3 className="font-extrabold text-sm tracking-tight text-white leading-tight">
                {currentUser && !showSwitchForm ? 'Account & Session' : 'FieldProof Sign In'}
              </h3>
              <p className="text-[11px] text-white/80 font-medium">
                Hays + Sons Restoration Portal
              </p>
            </div>
          </div>

          <button 
            id="btn-close-auth-modal"
            onClick={onClose}
            className="text-white/80 hover:text-white p-1 rounded-lg hover:bg-white/10 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body Content */}
        <div className="p-5 sm:p-6 overflow-y-auto flex-1 space-y-4">

          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-500 mt-0.5" />
              <div className="flex-1 font-medium">{error}</div>
            </div>
          )}

          {/* CASE 1: LOGGED IN USER PROFILE */}
          {currentUser && !showSwitchForm ? (
            <div className="space-y-4">
              
              {/* Active User Card */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Currently Signed In As
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider border ${
                    currentUser.role === 'pm'
                      ? 'bg-red-50 text-[#C81D25] border-red-200'
                      : 'bg-amber-50 text-amber-800 border-amber-200'
                  }`}>
                    {currentUser.role === 'pm' ? 'Project Manager' : 'Subcontractor'}
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-sm shadow-sm shrink-0 ${
                    currentUser.role === 'pm' ? 'bg-[#C81D25]' : 'bg-slate-800'
                  }`}>
                    {currentUser.role === 'pm' ? <Briefcase className="w-5 h-5" /> : <HardHat className="w-5 h-5 text-amber-400" />}
                  </div>

                  <div className="min-w-0 flex-1">
                    <h4 className="font-extrabold text-slate-900 text-base leading-tight truncate">
                      {currentUser.name}
                    </h4>
                    <p className="text-xs text-slate-500 truncate flex items-center gap-1 mt-0.5">
                      <Mail className="w-3 h-3 shrink-0" />
                      <span>{currentUser.email}</span>
                    </p>
                    {currentUser.company && (
                      <p className="text-xs text-slate-600 font-medium truncate flex items-center gap-1 mt-0.5">
                        <Building2 className="w-3 h-3 shrink-0" />
                        <span>{currentUser.company}</span>
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Explicit, Big Sign Out Button */}
              <div className="pt-2">
                <button
                  id="btn-modal-sign-out"
                  onClick={() => {
                    onLogout();
                    onClose();
                  }}
                  className="w-full py-2.5 px-4 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs flex items-center justify-center gap-2 transition shadow-sm"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out of FieldProof</span>
                </button>
              </div>

              {/* Option to login with another custom email */}
              <div className="text-center pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowSwitchForm(true)}
                  className="text-xs text-slate-500 hover:text-slate-800 transition"
                >
                  Need to sign in with a different email? <span className="font-semibold text-[#C81D25] underline">Enter credentials</span>
                </button>
              </div>

            </div>
          ) : (
            /* CASE 2: SIGN IN WITH ANOTHER EMAIL */
            <form onSubmit={handleDirectLogin} className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="email"
                    required
                    placeholder="name@haysandsons.com or sub@trade.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#C81D25]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    placeholder="Enter password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl pl-9 pr-9 py-2 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#C81D25]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 transition"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 rounded-xl font-bold text-white bg-[#C81D25] hover:bg-[#A3161D] transition flex items-center justify-center gap-2 text-xs disabled:opacity-60"
              >
                {isLoading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <span>Sign In</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              {currentUser && (
                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => setShowSwitchForm(false)}
                    className="text-xs text-slate-500 hover:text-slate-800 transition"
                  >
                    ← Back to active account
                  </button>
                </div>
              )}
            </form>
          )}

        </div>
      </div>
    </div>
  );
};
