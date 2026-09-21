import React, { useState } from 'react';
import { 
  Lock, 
  User as UserIcon, 
  HardHat, 
  Building2, 
  Mail, 
  ArrowRight, 
  AlertCircle, 
  CheckCircle2, 
  Briefcase,
  Eye,
  EyeOff,
  Sparkles
} from 'lucide-react';
import { User, UserRole } from '../types';
import { HaysLogo } from './HaysLogo';
import { safeFetchJson } from '../utils/api';

interface SubcontractorAuthPageProps {
  onLoginSuccess: (user: User, token: string) => void;
}

export const SubcontractorAuthPage: React.FC<SubcontractorAuthPageProps> = ({
  onLoginSuccess
}) => {
  // Mode: 'login' | 'register'
  const [mode, setMode] = useState<'login' | 'register'>('login');

  // Form Fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  
  // Registration Fields
  const [name, setName] = useState('');
  const [registerRole, setRegisterRole] = useState<UserRole>('subcontractor');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');

  // Status states
  const [isLoading, setIsLoading] = useState(false);
  const [quickLoadingRole, setQuickLoadingRole] = useState<'pm' | 'subcontractor' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  // Standard Login (Unified for PMs & Subcontractors)
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessNotice(null);

    const cleanEmail = email.trim();
    const cleanPassword = password.trim();

    if (!cleanEmail || !cleanPassword) {
      setErrorMessage('Please enter both your email address and password.');
      return;
    }

    setIsLoading(true);
    const { ok, data, error } = await safeFetchJson<{ success: boolean; user: User; token: string; error?: string }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cleanEmail, password: cleanPassword })
    });

    if (!ok || !data?.success) {
      setErrorMessage(error || data?.error || 'Invalid email or password.');
      setIsLoading(false);
      return;
    }

    onLoginSuccess(data.user, data.token);
  };

  // Instant 1-Click Quick Demo Login
  const handleQuickLogin = async (role: 'pm' | 'subcontractor') => {
    setErrorMessage(null);
    setSuccessNotice(null);
    setQuickLoadingRole(role);

    const { ok, data, error } = await safeFetchJson<{ success: boolean; user: User; token: string; error?: string }>('/api/auth/quick-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    });

    if (!ok || !data?.success) {
      setErrorMessage(error || data?.error || 'Quick login failed. Please try standard sign in.');
      setQuickLoadingRole(null);
      return;
    }

    onLoginSuccess(data.user, data.token);
  };

  // Simplified Account Registration
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessNotice(null);

    if (!name.trim()) {
      setErrorMessage('Please enter your full name.');
      return;
    }
    if (!email.trim()) {
      setErrorMessage('Please enter your email address.');
      return;
    }
    if (!password.trim() || password.length < 6) {
      setErrorMessage('Password must be at least 6 characters.');
      return;
    }

    setIsLoading(true);
    const { ok, data, error } = await safeFetchJson<{ success: boolean; user: User; token: string; error?: string }>('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim(),
        role: registerRole,
        company: company.trim() || (registerRole === 'pm' ? 'Hays + Sons Restoration' : 'Trade Partner'),
        phone: phone.trim(),
        password: password.trim()
      })
    });

    if (!ok || !data?.success) {
      setErrorMessage(error || data?.error || 'Registration failed.');
      setIsLoading(false);
      return;
    }

    setSuccessNotice('Account created successfully! Signing in...');
    setTimeout(() => {
      onLoginSuccess(data.user, data.token);
    }, 500);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-[#C81D25] selection:text-white font-sans">
      
      {/* Top Header Bar */}
      <header className="border-b border-slate-800 bg-slate-900/90 px-4 py-3 sticky top-0 z-20 shadow-sm backdrop-blur-sm">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <HaysLogo size="sm" showWordmark={true} showTagline={false} lightText={true} />
          <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-[#C81D25]/20 text-red-300 border border-[#C81D25]/40">
            FieldProof
          </span>
        </div>
      </header>

      {/* Main Authentication Container */}
      <main className="flex-1 flex items-center justify-center px-4 py-8 z-10">
        <div className="w-full max-w-md">
          
          {/* Header text */}
          <div className="text-center mb-6">
            <h1 className="text-2xl font-black text-white tracking-tight">
              {mode === 'login' ? 'Sign In to FieldProof' : 'Create an Account'}
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              {mode === 'login' 
                ? 'Hays + Sons Restoration • Work orders, photo verification & dispatch'
                : 'Join the Hays + Sons FieldProof subcontractor & PM portal'}
            </p>
          </div>

          {/* Form Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            
            {/* Clear Mode Switcher Tabs */}
            <div className="flex rounded-xl bg-slate-950 p-1 border border-slate-800 mb-5">
              <button
                id="tab-mode-login"
                type="button"
                onClick={() => {
                  setMode('login');
                  setErrorMessage(null);
                  setSuccessNotice(null);
                }}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                  mode === 'login'
                    ? 'bg-[#C81D25] text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Sign In</span>
              </button>
              <button
                id="tab-mode-register"
                type="button"
                onClick={() => {
                  setMode('register');
                  setErrorMessage(null);
                  setSuccessNotice(null);
                }}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                  mode === 'register'
                    ? 'bg-[#C81D25] text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <UserIcon className="w-3.5 h-3.5" />
                <span>Create Account</span>
              </button>
            </div>

            {/* Error Message */}
            {errorMessage && (
              <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs flex items-start gap-2 animate-in fade-in">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
                <div className="flex-1 font-medium">{errorMessage}</div>
              </div>
            )}

            {/* Success Message */}
            {successNotice && (
              <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-300 text-xs flex items-start gap-2 animate-in fade-in">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400 mt-0.5" />
                <div className="flex-1 font-medium">{successNotice}</div>
              </div>
            )}

            {/* 1. UNIFIED SIGN IN FORM */}
            {mode === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="input-login-email"
                      type="email"
                      required
                      placeholder="name@haysandsons.com or sub@contractor.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#C81D25] focus:ring-1 focus:ring-[#C81D25] transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="input-login-password"
                      type={showPassword ? 'text' : 'password'}
                      required
                      placeholder="Enter password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-10 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-[#C81D25] focus:ring-1 focus:ring-[#C81D25] transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  id="btn-login-submit"
                  type="submit"
                  disabled={isLoading || quickLoadingRole !== null}
                  className="w-full py-3 px-4 rounded-xl font-bold text-white bg-[#C81D25] hover:bg-[#A3161D] shadow-lg shadow-[#C81D25]/25 transition-all flex items-center justify-center gap-2 mt-2 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isLoading ? (
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <>
                      <span>Sign In</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                {/* Quick 1-Click Demo Logins Section */}
                <div className="pt-4 border-t border-slate-800/80">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      1-Click Instant Demo Access
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      id="btn-quick-pm"
                      type="button"
                      disabled={isLoading || quickLoadingRole !== null}
                      onClick={() => handleQuickLogin('pm')}
                      className="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-950 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 text-left transition group"
                    >
                      <div className="w-7 h-7 rounded-lg bg-[#C81D25]/20 text-red-400 border border-[#C81D25]/30 flex items-center justify-center shrink-0">
                        <Briefcase className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-white group-hover:text-red-300 transition">
                          {quickLoadingRole === 'pm' ? 'Signing in...' : 'Project Manager'}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">Ryan Russell (PM)</div>
                      </div>
                    </button>

                    <button
                      id="btn-quick-sub"
                      type="button"
                      disabled={isLoading || quickLoadingRole !== null}
                      onClick={() => handleQuickLogin('subcontractor')}
                      className="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-950 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 text-left transition group"
                    >
                      <div className="w-7 h-7 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center shrink-0">
                        <HardHat className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-white group-hover:text-amber-300 transition">
                          {quickLoadingRole === 'subcontractor' ? 'Signing in...' : 'Subcontractor'}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">Dave Miller (Crew)</div>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Create Account Link */}
                <div className="text-center pt-3 border-t border-slate-800/80">
                  <button
                    id="btn-switch-to-register"
                    type="button"
                    onClick={() => {
                      setMode('register');
                      setErrorMessage(null);
                      setSuccessNotice(null);
                    }}
                    className="text-xs text-slate-400 hover:text-white transition"
                  >
                    Need a new account? <span className="text-[#C81D25] font-bold underline">Create one here</span>
                  </button>
                </div>
              </form>
            ) : (
              /* 2. SIMPLE REGISTRATION FORM */
              <form onSubmit={handleRegister} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1">
                    Full Name *
                  </label>
                  <div className="relative">
                    <UserIcon className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="input-reg-name"
                      type="text"
                      required
                      placeholder="e.g. Dave Miller"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-[#C81D25] focus:ring-1 focus:ring-[#C81D25] transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1">
                    Email Address *
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="input-reg-email"
                      type="email"
                      required
                      placeholder="email@company.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-[#C81D25] focus:ring-1 focus:ring-[#C81D25] transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1">
                    Role *
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setRegisterRole('subcontractor')}
                      className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                        registerRole === 'subcontractor'
                          ? 'bg-[#C81D25] text-white border-[#C81D25]'
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                      }`}
                    >
                      <HardHat className="w-3.5 h-3.5" />
                      <span>Subcontractor</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setRegisterRole('pm')}
                      className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                        registerRole === 'pm'
                          ? 'bg-[#C81D25] text-white border-[#C81D25]'
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                      }`}
                    >
                      <Briefcase className="w-3.5 h-3.5" />
                      <span>Project Manager</span>
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1">
                    Company Name
                  </label>
                  <div className="relative">
                    <Building2 className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="input-reg-company"
                      type="text"
                      placeholder={registerRole === 'pm' ? 'Hays + Sons Restoration' : 'e.g. Apex Drywall LLC'}
                      value={company}
                      onChange={e => setCompany(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-[#C81D25] focus:ring-1 focus:ring-[#C81D25] transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1">
                    Password *
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="input-reg-password"
                      type="password"
                      required
                      placeholder="At least 6 characters"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-[#C81D25] focus:ring-1 focus:ring-[#C81D25] transition"
                    />
                  </div>
                </div>

                <button
                  id="btn-reg-submit"
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 rounded-xl font-bold text-white bg-[#C81D25] hover:bg-[#A3161D] shadow-lg shadow-[#C81D25]/25 transition-all flex items-center justify-center gap-2 mt-2 disabled:opacity-60"
                >
                  {isLoading ? (
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <>
                      <span>Create Account & Sign In</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setErrorMessage(null);
                      setSuccessNotice(null);
                    }}
                    className="text-xs text-slate-400 hover:text-white transition"
                  >
                    Already have an account? <span className="text-[#C81D25] font-bold underline">Sign In</span>
                  </button>
                </div>
              </form>
            )}

          </div>

          <div className="mt-4 text-center text-[11px] text-slate-500">
            Hays + Sons Restoration • FieldProof Mobile & Desktop Portal
          </div>
        </div>
      </main>

      {/* Clean Bottom Strip */}
      <footer className="border-t border-slate-900 bg-slate-950 py-3 px-4 text-center text-[11px] text-slate-500">
        Hays + Sons Trade Partner Verification • Clean-State Production
      </footer>
    </div>
  );
};
