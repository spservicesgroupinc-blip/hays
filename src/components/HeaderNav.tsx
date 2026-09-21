import React from 'react';
import { 
  ShieldCheck, 
  HardHat, 
  ClipboardList, 
  Smartphone, 
  Monitor, 
  ChevronDown, 
  User as UserIcon, 
  Lock, 
  ArrowLeftRight,
  Download,
  LogOut
} from 'lucide-react';
import { WorkOrder, User } from '../types';
import { HaysLogo } from './HaysLogo';
import { PWAInstallButton } from './PWAInstallButton';

export type AppTab = 'pm_hub' | 'pm_creator' | 'pm_manual' | 'subcontractor';

interface HeaderNavProps {
  currentTab: AppTab;
  setTab: (tab: AppTab) => void;
  isMobileDeviceFrame: boolean;
  setIsMobileDeviceFrame: (val: boolean) => void;
  workOrders: WorkOrder[];
  selectedWoId: string;
  onSelectWo: (woId: string) => void;
  currentUser: User | null;
  onOpenAuthModal: () => void;
  onLogout: () => void;
  onOpenInstallGuide?: () => void;
}

export const HeaderNav: React.FC<HeaderNavProps> = ({
  currentTab,
  setTab,
  isMobileDeviceFrame,
  setIsMobileDeviceFrame,
  workOrders,
  selectedWoId,
  onSelectWo,
  currentUser,
  onOpenAuthModal,
  onLogout,
  onOpenInstallGuide
}) => {
  const isSubcontractor = currentUser?.role === 'subcontractor';

  return (
    <>
      {/* Sleek, Single-Row Top Navigation Bar */}
      <header className="bg-slate-950 text-white border-b border-[#C81D25] sticky top-0 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 h-13 sm:h-15 flex items-center justify-between gap-2">
          
          {/* Brand Logo & Name */}
          <div className="flex items-center gap-2 shrink-0">
            <HaysLogo size="sm" showWordmark={true} showTagline={false} lightText={true} />
            <span className="hidden sm:inline-block text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-[#C81D25]/20 text-red-300 border border-[#C81D25]/40 ml-1">
              FieldProof
            </span>
          </div>

          {/* Desktop Navigation Tabs (Hidden on mobile phones, shown on md+) */}
          <nav className="hidden md:flex items-center bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs font-semibold shadow-inner">
            {/* PM JOBS & ORDERS */}
            <button
              id="nav-pm-hub"
              onClick={() => {
                if (isSubcontractor) {
                  onOpenAuthModal();
                } else {
                  setTab('pm_hub');
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
                currentTab === 'pm_hub'
                  ? 'bg-[#C81D25] text-white shadow-md font-bold'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <ClipboardList className="w-3.5 h-3.5" />
              <span>Jobs & Orders</span>
            </button>

            {/* SUBCONTRACTOR VIEW */}
            <button
              id="nav-subcontractor"
              onClick={() => setTab('subcontractor')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
                currentTab === 'subcontractor'
                  ? 'bg-[#C81D25] text-white shadow-md font-bold'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <HardHat className="w-3.5 h-3.5" />
              <span>Subcontractor Portal</span>
            </button>

            {/* UPLOAD ESTIMATE */}
            {!isSubcontractor && (
              <button
                id="nav-pm-manual-work-order"
                onClick={() => setTab('pm_manual')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
                  currentTab === 'pm_manual'
                    ? 'bg-[#C81D25] text-white shadow-md font-bold'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <span className="text-[#C81D25] bg-white rounded-full w-3.5 h-3.5 flex items-center justify-center text-[10px] font-black leading-none">+</span>
                <span>Manual Work Order</span>
              </button>
            )}

            {!isSubcontractor && (
              <button
                id="nav-pm-creator"
                onClick={() => setTab('pm_creator')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
                  currentTab === 'pm_creator'
                    ? 'bg-[#C81D25] text-white shadow-md font-bold'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <span className="text-[#C81D25] bg-white rounded-full w-3.5 h-3.5 flex items-center justify-center text-[10px] font-black leading-none">
                  +
                </span>
                <span>Upload Estimate</span>
              </button>
            )}
          </nav>

          {/* Right Action Controls */}
          <div className="flex items-center gap-2 shrink-0">
            {/* PWA Download / Install App Button */}
            <PWAInstallButton variant="compact" />

            {/* Quick Job Switcher (Desktop or tablets) */}
            {currentTab === 'subcontractor' && workOrders.length > 1 && (
              <div className="hidden sm:flex relative items-center">
                <select
                  id="select-work-order"
                  value={selectedWoId}
                  onChange={(e) => onSelectWo(e.target.value)}
                  aria-label="Select Work Order"
                  className="bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg pl-2 pr-6 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#C81D25] font-mono font-medium appearance-none cursor-pointer max-w-[140px] md:max-w-[180px] truncate"
                >
                  {workOrders.map((wo) => (
                    <option key={wo.woId} value={wo.woId}>
                      {wo.woId} - {wo.projectName}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-3 h-3 text-slate-400 absolute right-1.5 pointer-events-none" />
              </div>
            )}

            {/* User Profile / Switch Role Button */}
            <button
              id="btn-user-profile"
              onClick={onOpenAuthModal}
              title="Click to view profile or switch role"
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition min-h-[38px] active:scale-95"
            >
              <div className={`w-6 h-6 rounded-lg flex items-center justify-center font-bold text-[11px] shrink-0 ${
                currentUser?.role === 'pm'
                  ? 'bg-[#C81D25] text-white'
                  : 'bg-amber-600 text-white'
              }`}>
                {currentUser?.role === 'pm' ? 'PM' : 'SUB'}
              </div>

              <div className="text-left leading-none max-w-[90px] sm:max-w-[130px] truncate">
                <span className="font-bold block truncate text-[11px] sm:text-xs">
                  {currentUser ? currentUser.name.split(' ')[0] : 'User'}
                </span>
                <span className="text-[9px] text-slate-400 block truncate mt-0.5">
                  {currentUser?.role === 'pm' ? 'Hays PM' : (currentUser?.company ? currentUser.company.slice(0, 12) : 'Sub')}
                </span>
              </div>
            </button>

            {/* Clear, Dedicated Sign Out Button */}
            <button
              id="btn-header-sign-out"
              onClick={onLogout}
              title="Sign Out of FieldProof"
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-red-950/60 border border-slate-800 hover:border-red-600/50 text-slate-300 hover:text-red-300 text-xs font-semibold transition active:scale-95 min-h-[38px]"
            >
              <LogOut className="w-3.5 h-3.5 text-red-500 shrink-0" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>

        </div>
      </header>

      {/* Mobile Bottom Navigation Bar (Streamlined for One-Thumb Smartphone Use) */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur-md border-t border-slate-800/80 px-2 py-1 flex items-center justify-around shadow-2xl safe-area-bottom">
        {/* Tab 1: Subcontractor Tasks */}
        <button
          onClick={() => setTab('subcontractor')}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition min-h-[44px] flex-1 ${
            currentTab === 'subcontractor'
              ? 'text-[#C81D25] font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <HardHat className="w-5 h-5 mb-0.5" />
          <span className="text-[10px] leading-none">Subcontractor</span>
        </button>

        {/* Tab 2: PM Dashboard (If PM) or Switch to PM */}
        <button
          onClick={() => {
            if (isSubcontractor) {
              onOpenAuthModal();
            } else {
              setTab('pm_hub');
            }
          }}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition min-h-[44px] flex-1 ${
            currentTab === 'pm_hub'
              ? 'text-[#C81D25] font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <ClipboardList className="w-5 h-5 mb-0.5" />
          <span className="text-[10px] leading-none">Jobs</span>
        </button>

        {/* Tab 3: Upload Estimate (PM only) */}
        {!isSubcontractor && (
          <button
            id="mobile-nav-new-job"
            onClick={() => setTab('pm_manual')}
            className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition min-h-[44px] flex-1 ${
              currentTab === 'pm_manual'
                ? 'text-[#C81D25] font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="text-base font-black leading-none mb-0.5">+</span>
            <span className="text-[10px] leading-none">New Work Order</span>
          </button>
        )}

        {/* Tab 4: Sign Out on Mobile */}
        <button
          id="mobile-nav-sign-out"
          onClick={onLogout}
          title="Sign Out"
          className="flex flex-col items-center justify-center py-1 px-2 rounded-xl transition min-h-[44px] flex-1 text-slate-400 hover:text-red-400 active:scale-95"
        >
          <LogOut className="w-5 h-5 mb-0.5 text-red-500" />
          <span className="text-[10px] leading-none text-slate-300">Sign Out</span>
        </button>
      </div>
    </>
  );
};
