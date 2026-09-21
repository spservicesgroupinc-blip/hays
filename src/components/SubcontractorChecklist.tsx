import React, { useState, useEffect } from 'react';
import { 
  Camera, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  ExternalLink, 
  RotateCcw, 
  FileCheck2, 
  Check, 
  X, 
  Calendar, 
  MapPin, 
  UserCheck, 
  Phone, 
  Info,
  ShieldAlert,
  Lock,
  ArrowRight,
  ShieldCheck
} from 'lucide-react';
import { WorkOrder, LineItem, User } from '../types';
import { HaysLogo } from './HaysLogo';

interface SubcontractorChecklistProps {
  workOrder: WorkOrder | null;
  lineItems: LineItem[];
  onPhotoUploaded: (lineId: string, base64: string, mimeType: string, taskDescription: string) => Promise<void>;
  onSignOff: (signerName: string) => Promise<void>;
  isLoading: boolean;
  verifyingLineId: string | null;
  currentUser: User | null;
  accessDeniedError?: string | null;
  onSwitchToAssignedWo?: (woId: string) => void;
  onOpenAuthModal: () => void;
}

export const SubcontractorChecklist: React.FC<SubcontractorChecklistProps> = ({
  workOrder,
  lineItems,
  onPhotoUploaded,
  onSignOff,
  isLoading,
  verifyingLineId,
  currentUser,
  accessDeniedError,
  onSwitchToAssignedWo,
  onOpenAuthModal
}) => {
  const [showSignOffModal, setShowSignOffModal] = useState(false);
  const [signerName, setSignerName] = useState(currentUser?.name || '');
  const [isSigning, setIsSigning] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  useEffect(() => {
    if (currentUser?.name) {
      setSignerName(currentUser.name);
    }
  }, [currentUser]);

  // 1. ACCESS DENIED (403 FORBIDDEN) SCREEN
  if (accessDeniedError) {
    const firstAssignedWo = currentUser?.assignedWoIds && currentUser.assignedWoIds.length > 0
      ? currentUser.assignedWoIds[0]
      : null;

    return (
      <div className="max-w-xl mx-auto px-4 py-8 animate-in fade-in">
        <div className="bg-white rounded-3xl p-6 sm:p-8 shadow-xl border border-red-200 text-center relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-2 bg-[#C81D25]" />
          
          <div className="w-16 h-16 rounded-2xl bg-red-50 text-[#C81D25] flex items-center justify-center mx-auto mb-4 border border-red-200 shadow-inner">
            <Lock className="w-8 h-8" />
          </div>

          <span className="text-[11px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full bg-red-100 text-[#C81D25] border border-red-200 inline-block mb-2">
            403 Forbidden • Access Restricted
          </span>

          <h2 className="text-xl font-black text-slate-900 mb-2">
            Unauthorized Work Order Access
          </h2>

          <p className="text-xs text-red-700 font-medium bg-red-50 p-3 rounded-xl border border-red-200 mb-5 leading-relaxed">
            {accessDeniedError}
          </p>

          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200 text-left text-xs text-slate-600 space-y-2 mb-6">
            <div className="flex items-center gap-2 font-bold text-slate-800">
              <ShieldAlert className="w-4 h-4 text-[#C81D25]" />
              <span>Hays + Sons Trade Isolation Policy</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              To guarantee quality and scope accountability, subcontractors can only view and inspect work orders assigned specifically to their trade crew.
            </p>
            {currentUser && (
              <div className="pt-2 border-t border-slate-200 text-[11px] flex justify-between">
                <span className="text-slate-500">Current User:</span>
                <span className="font-bold text-slate-800">{currentUser.name} ({currentUser.company})</span>
              </div>
            )}
          </div>

          <div className="space-y-2.5">
            {firstAssignedWo && onSwitchToAssignedWo && (
              <button
                onClick={() => onSwitchToAssignedWo(firstAssignedWo)}
                className="w-full py-3 px-4 rounded-xl bg-[#C81D25] hover:bg-[#A8151D] text-white font-bold text-xs shadow-lg shadow-red-600/20 transition flex items-center justify-center gap-2"
              >
                <span>Switch to My Assigned Job ({firstAssignedWo})</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}

            <button
              onClick={onOpenAuthModal}
              className="w-full py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs transition border border-slate-300"
            >
              Switch Account (Log in as Hays + Sons PM or Sub)
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 2. LOADING SCREEN
  if (!workOrder) {
    return (
      <div className="p-8 text-center bg-white rounded-2xl border border-slate-200 shadow-sm max-w-md mx-auto my-8">
        <Clock className="w-10 h-10 text-[#C81D25] mx-auto mb-3 animate-spin" />
        <h3 className="text-base font-bold text-slate-800">Loading Work Order...</h3>
        <p className="text-xs text-slate-500 mt-1">Verifying credentials and restoration scope items.</p>
      </div>
    );
  }

  const total = lineItems.length;
  const completed = lineItems.filter(i => i.status === 'Completed').length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isAllDone = total > 0 && completed === total;

  const handleFileChange = async (lineId: string, taskDesc: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = '';

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      const mimeType = file.type || 'image/jpeg';
      await onPhotoUploaded(lineId, base64, mimeType, taskDesc);
    };
    reader.readAsDataURL(file);
  };

  const handleConfirmSignOff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signerName.trim()) return;
    setIsSigning(true);
    try {
      await onSignOff(signerName.trim());
      setShowSignOffModal(false);
    } finally {
      setIsSigning(false);
    }
  };

  return (
    <div className="relative pb-48 md:pb-24 text-slate-900 animate-in fade-in">
      
      {/* 1. COMPACT JOB HEADER & PROGRESS */}
      <div className="bg-slate-950 text-white rounded-2xl p-4 sm:p-5 shadow-md border-b-2 border-[#C81D25] mb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                {workOrder.woId}
              </span>
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                workOrder.status === 'Completed'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              }`}>
                {workOrder.status}
              </span>
            </div>

            <h1 className="text-base sm:text-lg font-black text-white truncate leading-tight">
              {workOrder.projectName}
            </h1>

            <div className="flex items-center gap-1 text-xs text-slate-300 mt-1 truncate">
              <MapPin className="w-3.5 h-3.5 text-[#C81D25] shrink-0" />
              <span className="truncate">{workOrder.unitArea}</span>
            </div>
          </div>

          {/* Progress Pill */}
          <div className="text-right shrink-0 bg-slate-900 px-3 py-2 rounded-xl border border-slate-800">
            <div className="text-xl font-black text-white leading-none">
              <span className="text-[#C81D25]">{percent}</span>%
            </div>
            <div className="text-[10px] font-semibold text-slate-400 mt-1">
              {completed}/{total} Done
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mt-3 bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
          <div 
            className="bg-[#C81D25] h-full rounded-full transition-all duration-300 shadow-sm"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* 2. SIGNED OFF BADGE (If completed) */}
      {workOrder.status === 'Completed' && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl p-3 flex items-center gap-2.5 mb-4 text-xs">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <div>
            <span className="font-bold block">Work Order Fully Certified</span>
            <span className="text-emerald-700 text-[11px]">
              Signed off by {workOrder.signedBy || 'Subcontractor Lead'} {workOrder.signedAt ? `on ${workOrder.signedAt}` : ''}.
            </span>
          </div>
        </div>
      )}

      {/* 3. LINE ITEM CARDS */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <span className="text-xs font-black uppercase tracking-wider text-slate-700">
            Scope Checklist ({total} Items)
          </span>
          <span className="text-[11px] text-slate-500">
            Photo required per item
          </span>
        </div>

        {lineItems.map((item, index) => {
          const isItemLoading = verifyingLineId === item.lineId;
          const isCompleted = item.status === 'Completed';
          const isFlagged = item.status === 'Flagged';

          return (
            <div
              key={item.lineId}
              id={`line-card-${item.lineId}`}
              className={`bg-white rounded-xl p-3.5 sm:p-4 shadow-xs border transition ${
                isCompleted 
                  ? 'border-slate-200' 
                  : (isFlagged ? 'border-red-300 bg-red-50/10' : 'border-slate-200')
              }`}
            >
              {/* Line Item Header */}
              <div className="flex items-start justify-between gap-2.5">
                <div className="flex items-start gap-2.5 flex-1 min-w-0">
                  <span className={`w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                    isCompleted 
                      ? 'bg-emerald-600 text-white' 
                      : (isFlagged ? 'bg-red-600 text-white' : 'bg-slate-900 text-white')
                  }`}>
                    {isCompleted ? <Check className="w-3 h-3 stroke-[3]" /> : index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs sm:text-sm font-bold text-slate-900 leading-snug">
                      {item.taskDescription}
                    </p>
                  </div>
                </div>

                {/* Status Chip */}
                <div className="shrink-0">
                  {isCompleted ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                      <span>VERIFIED</span>
                    </span>
                  ) : isFlagged ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-red-100 text-red-800">
                      <AlertTriangle className="w-3 h-3 text-red-600" />
                      <span>RETAKE</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600">
                      <Clock className="w-3 h-3 text-slate-400" />
                      <span>Pending</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Optional Note */}
              {item.notes && (
                <div className="mt-2.5 p-2 rounded-lg bg-slate-50 border border-slate-200 text-[11px] text-slate-600">
                  {item.notes}
                </div>
              )}

              {/* Photo & Actions Area */}
              <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2.5">
                {/* Thumbnail if photo exists */}
                {item.photoUrl ? (
                  <div className="flex items-center gap-2">
                    <div 
                      onClick={() => setPreviewImage(item.photoUrl)}
                      className="relative w-12 h-12 rounded-lg overflow-hidden bg-slate-900 border border-slate-300 cursor-pointer shrink-0"
                    >
                      <img 
                        src={item.photoUrl} 
                        alt="Proof" 
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <span className="text-[11px] text-slate-500">Photo logged</span>
                  </div>
                ) : (
                  <span className="text-[11px] text-slate-400 italic">No photo yet</span>
                )}

                {/* Finger-Friendly Camera Button */}
                <label 
                  htmlFor={`file-input-${item.lineId}`}
                  className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl font-bold text-xs transition cursor-pointer min-h-[42px] active:scale-95 ${
                    isItemLoading 
                      ? 'bg-slate-200 text-slate-500 cursor-not-allowed' 
                      : (isCompleted
                        ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300'
                        : (isFlagged
                          ? 'bg-red-700 hover:bg-red-800 text-white shadow-sm'
                          : 'bg-[#C81D25] hover:bg-[#A8151D] text-white shadow-sm'))
                  }`}
                >
                  {isItemLoading ? (
                    <>
                      <Clock className="w-3.5 h-3.5 animate-spin text-[#C81D25]" />
                      <span>Uploading...</span>
                    </>
                  ) : isCompleted ? (
                    <>
                      <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
                      <span>Retake</span>
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4" />
                      <span>Take Photo</span>
                    </>
                  )}

                  <input
                    id={`file-input-${item.lineId}`}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    disabled={isItemLoading}
                    onChange={(e) => handleFileChange(item.lineId, item.taskDescription, e)}
                    className="hidden"
                  />
                </label>
              </div>

            </div>
          );
        })}
      </div>

      {/* 4. DOCKED SIGN-OFF BAR - Positioned safely above mobile bottom bar */}
      <div className="fixed bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))] md:bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200 p-2.5 sm:p-4 shadow-xl">
        <div className="max-w-xl mx-auto flex items-center justify-between gap-3">
          <div className="text-xs">
            <div className="font-bold text-slate-900">
              {completed} of {total} verified
            </div>
            <div className="text-[10px] text-slate-500">
              {isAllDone 
                ? 'Ready for sign-off' 
                : `${total - completed} photos left`}
            </div>
          </div>

          <button
            id="btn-sign-off"
            onClick={() => setShowSignOffModal(true)}
            disabled={!isAllDone || workOrder.status === 'Completed'}
            className={`px-4 py-2.5 rounded-xl font-bold text-xs transition shadow-sm flex items-center gap-1.5 min-h-[42px] active:scale-95 ${
              workOrder.status === 'Completed'
                ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-default'
                : (isAllDone
                  ? 'bg-[#C81D25] hover:bg-[#A8151D] text-white shadow-red-600/30'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed')
            }`}
          >
            <FileCheck2 className="w-4 h-4" />
            <span>{workOrder.status === 'Completed' ? 'Signed Off' : 'Sign Off & Complete'}</span>
          </button>
        </div>
      </div>

      {/* 5. SIGN OFF MODAL */}
      {showSignOffModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl border border-slate-200 relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-[#C81D25]" />

            <div className="flex items-center justify-between mb-3 mt-1">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-red-50 text-[#C81D25] flex items-center justify-center font-bold border border-red-200">
                  <FileCheck2 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900">Subcontractor Sign-Off</h3>
                  <p className="text-[10px] text-slate-500">Hays + Sons Verification</p>
                </div>
              </div>
              <button 
                onClick={() => setShowSignOffModal(false)}
                className="p-1 rounded-full text-slate-400 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-600 mb-3 leading-relaxed">
              I certify that all {total} restoration items for <strong>{workOrder.projectName}</strong> have been completed and verified by on-site photo.
            </p>

            <form onSubmit={handleConfirmSignOff} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">
                  Signer Full Name *
                </label>
                <input
                  id="input-signer-name"
                  type="text"
                  required
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  placeholder="Crew Lead / Trade Representative"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-xs text-slate-900 font-medium focus:outline-none focus:border-[#C81D25] min-h-[42px]"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowSignOffModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 font-bold text-xs hover:bg-slate-50 min-h-[42px]"
                >
                  Cancel
                </button>
                <button
                  id="btn-confirm-sign-off"
                  type="submit"
                  disabled={isSigning || !signerName.trim()}
                  className="flex-1 py-2.5 rounded-xl bg-[#C81D25] hover:bg-[#A8151D] text-white font-bold text-xs shadow-md transition flex items-center justify-center gap-1.5 min-h-[42px] disabled:opacity-60"
                >
                  {isSigning ? (
                    <Clock className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      <span>Confirm & Sign</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 6. PHOTO ZOOM MODAL */}
      {previewImage && (
        <div 
          className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4 cursor-pointer"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-w-2xl w-full bg-slate-900 rounded-2xl overflow-hidden shadow-2xl border border-slate-800" onClick={e => e.stopPropagation()}>
            <div className="p-3 bg-slate-900 flex justify-between items-center text-white border-b border-slate-800">
              <span className="text-xs font-bold">Inspection Photo Review</span>
              <button 
                onClick={() => setPreviewImage(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <img src={previewImage} alt="Enlarged Inspection" className="w-full max-h-[75vh] object-contain bg-slate-950" />
          </div>
        </div>
      )}

    </div>
  );
};
