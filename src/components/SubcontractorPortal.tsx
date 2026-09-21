import React, { useState, useEffect } from 'react';
import { 
  HardHat, 
  ClipboardList, 
  ChevronRight, 
  ArrowLeft, 
  Calendar, 
  MapPin, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  FileCheck2, 
  ShieldCheck, 
  User as UserIcon,
  Sparkles,
  ExternalLink,
  Lock,
  LogOut
} from 'lucide-react';
import { WorkOrder, LineItem, User } from '../types';
import { SubcontractorChecklist } from './SubcontractorChecklist';
import { HaysLogo } from './HaysLogo';
import { PWAInstallButton } from './PWAInstallButton';

interface SubcontractorPortalProps {
  currentUser: User | null;
  workOrders: WorkOrder[];
  selectedWo: WorkOrder | null;
  lineItems: LineItem[];
  onSelectWo: (woId: string) => void;
  onPhotoUploaded: (lineId: string, base64: string, mimeType: string, taskDescription: string) => Promise<void>;
  onSignOff: (signerName: string) => Promise<void>;
  isLoadingWo: boolean;
  verifyingLineId: string | null;
  accessDeniedError?: string | null;
  onOpenAuthModal: () => void;
  onLogout?: () => void;
  isMobileDeviceFrame?: boolean;
}

export const SubcontractorPortal: React.FC<SubcontractorPortalProps> = ({
  currentUser,
  workOrders,
  selectedWo,
  lineItems,
  onSelectWo,
  onPhotoUploaded,
  onSignOff,
  isLoadingWo,
  verifyingLineId,
  accessDeniedError,
  onOpenAuthModal,
  onLogout
}) => {
  // If user is currently inspecting a specific work order, they can toggle back to view their job list
  const [activeWoId, setActiveWoId] = useState<string | null>(selectedWo?.woId || null);

  useEffect(() => {
    if (selectedWo?.woId) {
      setActiveWoId(selectedWo.woId);
    }
  }, [selectedWo?.woId]);

  const isSubcontractor = currentUser?.role === 'subcontractor';

  // Subcontractor's assigned jobs
  const myAssignedJobs = workOrders.filter(wo => {
    if (!currentUser) return false;
    if (currentUser.role === 'pm') return true; // PM viewing preview
    return (
      (wo.assignedSubId && wo.assignedSubId === currentUser.id) ||
      (currentUser.assignedWoIds && currentUser.assignedWoIds.includes(wo.woId))
    );
  });

  const handleOpenJob = (woId: string) => {
    setActiveWoId(woId);
    onSelectWo(woId);
  };

  const handleBackToJobList = () => {
    setActiveWoId(null);
  };

  return (
    <div className="max-w-4xl mx-auto px-3 py-4 sm:px-6 sm:py-6 space-y-4 animate-in fade-in">
      
      {/* 1. SUBCONTRACTOR BANNER - CLEAN & COMPACT */}
      <div className="bg-white rounded-2xl p-4 sm:p-5 border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center font-black shadow-sm shrink-0">
              <HardHat className="w-5 h-5 text-[#C81D25]" />
            </div>

            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-black text-slate-900 leading-tight truncate">
                {currentUser ? currentUser.company : 'Trade Subcontractor'}
              </h1>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5 truncate">
                <span>{currentUser ? currentUser.name : 'Crew'}</span>
                {currentUser?.trade && (
                  <>
                    <span>•</span>
                    <span className="font-semibold text-slate-700 truncate">{currentUser.trade}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onOpenAuthModal}
              title="Switch user role"
              className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition border border-slate-200"
            >
              Switch Role
            </button>
            {onLogout && (
              <button
                onClick={onLogout}
                title="Sign Out of FieldProof"
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-bold text-xs transition border border-red-200"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden xs:inline">Sign Out</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* PWA Home Screen Install Banner */}
      <PWAInstallButton variant="banner" />

      {/* 2. IF A WORK ORDER IS SELECTED: RENDER THE LINE-ITEM INSPECTION CHECKLIST */}
      {activeWoId && selectedWo ? (
        <div className="space-y-3">
          {/* Breadcrumb back to all jobs */}
          <div className="flex items-center justify-between">
            <button
              onClick={handleBackToJobList}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white hover:bg-slate-100 border border-slate-200 text-slate-800 text-xs font-bold transition shadow-xs"
            >
              <ArrowLeft className="w-4 h-4 text-[#C81D25]" />
              <span>Back to Jobs ({myAssignedJobs.length})</span>
            </button>

            <span className="text-xs font-mono font-bold text-slate-600 bg-white px-2.5 py-1 rounded-lg border border-slate-200">
              {selectedWo.woId}
            </span>
          </div>

          {/* Render Checklist */}
          <SubcontractorChecklist
            workOrder={selectedWo}
            lineItems={lineItems}
            onPhotoUploaded={onPhotoUploaded}
            onSignOff={onSignOff}
            isLoading={isLoadingWo}
            verifyingLineId={verifyingLineId}
            currentUser={currentUser}
            accessDeniedError={accessDeniedError}
            onSwitchToAssignedWo={(woId) => handleOpenJob(woId)}
            onOpenAuthModal={onOpenAuthModal}
          />
        </div>
      ) : (
        /* 3. OTHERWISE: RENDER THE SUBCONTRACTOR'S JOBS PAGE */
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-black text-slate-800 uppercase tracking-wider">
              Assigned Work Orders ({myAssignedJobs.length})
            </h2>
            <span className="text-[11px] text-slate-500">Tap to start inspection</span>
          </div>

          {myAssignedJobs.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center border border-slate-200 shadow-sm space-y-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-200">
                <Clock className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-black text-slate-900">No Work Orders Assigned Yet</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Your Hays + Sons Project Manager will dispatch jobs here. Check back or switch accounts.
              </p>
              <button
                onClick={onOpenAuthModal}
                className="px-3.5 py-2 rounded-xl bg-slate-900 text-white font-bold text-xs hover:bg-slate-800 transition"
              >
                Switch Account (PM View)
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {myAssignedJobs.map((wo) => {
                const pct = wo.totalItems > 0 ? Math.round((wo.completedItems / wo.totalItems) * 100) : 0;
                const isComplete = wo.status === 'Completed' || pct === 100;

                return (
                  <div
                    key={wo.woId}
                    onClick={() => handleOpenJob(wo.woId)}
                    className="bg-white rounded-xl p-4 border border-slate-200 hover:border-[#C81D25] shadow-xs hover:shadow-md transition cursor-pointer flex flex-col gap-2.5 active:scale-[0.99]"
                  >
                    {/* Status Strip */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-black text-xs px-2 py-0.5 rounded bg-slate-900 text-white">
                          {wo.woId}
                        </span>
                        <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                          isComplete
                            ? 'bg-emerald-100 text-emerald-800'
                            : (wo.status === 'In Progress'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-100 text-slate-700')
                        }`}>
                          {wo.status}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 text-[11px] text-slate-500">
                        <Calendar className="w-3 h-3 text-slate-400" />
                        <span>{wo.scheduledDate}</span>
                      </div>
                    </div>

                    {/* Job Details */}
                    <div>
                      <h3 className="text-sm font-black text-slate-900 leading-snug">
                        {wo.projectName}
                      </h3>
                      <div className="flex items-center gap-1 text-xs text-slate-600 mt-0.5">
                        <MapPin className="w-3 h-3 text-[#C81D25] shrink-0" />
                        <span className="truncate">{wo.unitArea}</span>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="space-y-1 pt-1">
                      <div className="flex justify-between text-[11px] font-bold">
                        <span className="text-slate-500">Progress</span>
                        <span className={pct === 100 ? 'text-emerald-600' : 'text-slate-800'}>
                          {wo.completedItems}/{wo.totalItems} Verified ({pct}%)
                        </span>
                      </div>
                      <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full transition-all duration-300 ${
                            pct === 100 ? 'bg-emerald-500' : 'bg-[#C81D25]'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>

                    {/* Open CTA */}
                    <div className="flex items-center justify-end pt-1">
                      <div className="flex items-center gap-1 text-xs font-bold text-[#C81D25]">
                        <span>{isComplete ? 'View Job' : 'Open Checklist'}</span>
                        <ChevronRight className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

    </div>
  );
};
