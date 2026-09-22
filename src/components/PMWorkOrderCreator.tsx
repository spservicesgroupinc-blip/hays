import React, { useState, useRef } from 'react';
import { 
  FileUp, 
  MapPin, 
  User as UserIcon, 
  Phone, 
  Calendar, 
  CheckCircle2, 
  ArrowRight, 
  Clock, 
  HardHat, 
  AlertCircle,
  FileText,
  Plus,
  Trash2,
  FolderCheck,
  Zap,
  Check
} from 'lucide-react';
import { WorkOrder, User, ExtractedJobData, Job } from '../types';
import { safeFetchJson } from '../utils/api';

interface PMWorkOrderCreatorProps {
  onWorkOrderCreated: (newWo: WorkOrder) => Promise<void>;
  onOpenSubcontractorView: (woId: string) => void;
  currentUser: User | null;
  authToken: string | null;
  onOpenAuthModal: () => void;
  onNavigateToJobsDashboard?: () => void;
}

export const PMWorkOrderCreator: React.FC<PMWorkOrderCreatorProps> = ({
  onWorkOrderCreated,
  onOpenSubcontractorView,
  currentUser,
  authToken,
  onOpenAuthModal,
  onNavigateToJobsDashboard
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [showPasteText, setShowPasteText] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Subcontractors directory (loaded live from API)
  const [subcontractors, setSubcontractors] = useState<Array<{ id: string; name: string; company: string; trade: string; phone: string }>>([]);

  // Created Job Result
  const [createdJob, setCreatedJob] = useState<Job | null>(null);
  const [tradeAssignments, setTradeAssignments] = useState<Array<{
    tradeName: string;
    subId: string;
    scheduledDate: string;
    tasks: string[];
    isCreated?: boolean;
    createdWoId?: string;
  }>>([]);
  const [isCreatingWorkOrders, setIsCreatingWorkOrders] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load registered subcontractors
  React.useEffect(() => {
    safeFetchJson<any>('/api/subcontractors')
      .then(({ ok, data }) => {
        if (ok && data?.success && Array.isArray(data.subcontractors) && data.subcontractors.length > 0) {
          setSubcontractors(data.subcontractors);
        }
      })
      .catch(() => {});
  }, []);

  // Upload & Extract Estimate
  const processEstimate = async (fileObj: File | null, rawText?: string) => {
    setIsProcessing(true);
    setErrorMsg(null);
    try {
      let base64Data = '';
      let mimeType = 'text/plain';
      let fileName = 'Estimate.txt';

      if (fileObj) {
        fileName = fileObj.name;
        mimeType = fileObj.type || (fileName.endsWith('.pdf') ? 'application/pdf' : 'text/plain');
        base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = reader.result as string;
            const b64 = res.includes(',') ? res.split(',')[1] : res;
            resolve(b64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(fileObj);
        });
      } else if (rawText) {
        fileName = 'Estimate_Paste.txt';
        mimeType = 'text/plain';
        base64Data = btoa(unescape(encodeURIComponent(rawText)));
      } else {
        throw new Error('Please select an estimate file or paste text.');
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const { ok, data: extractData, error: extractError } = await safeFetchJson<any>('/api/ai/extract-job-from-pdf', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base64: base64Data,
          mimeType,
          fileName,
          rawText: rawText || '',
          autoCreate: false
        })
      });

      const result = extractData;
      if (!ok || (!result?.success && !result?.data)) {
        throw new Error(extractError || result?.error || 'Failed to extract estimate information.');
      }

      const data: ExtractedJobData = result.data;
      const job: Job = result.job || {
        id: `JOB-${Math.floor(100 + Math.random() * 900)}`,
        customerName: data.insuredName || '',
        propertyAddress: data.propertyAddress || '',
        phone: (data as any).phone || '',
        claimNumber: data.claimNumber || '',
        lossType: data.lossType || '',
        totalEstimate: data.totalEstimate || '',
        scopeSummary: data.unitArea || '',
        extractedTrades: data.tradeBreakdown || [],
        extractedTasks: data.tasks || [],
        createdAt: new Date().toISOString(),
        workOrderIds: []
      };

      setCreatedJob(job);

      // Build Trade Work Order assignment list
      const tradeList = (data.tradeBreakdown && data.tradeBreakdown.length > 0)
        ? data.tradeBreakdown
        : [
            {
              tradeName: 'Flooring & Trim Restoration',
              tasks: data.tasks.slice(0, 4)
            },
            {
              tradeName: 'Carpentry & Detach/Reset',
              tasks: data.tasks.slice(4, 7)
            }
          ];

      const initialAssignments = tradeList.map((tg) => {
        const lower = tg.tradeName.toLowerCase();
        const matched = subcontractors.find(s => 
          (lower.includes('floor') && s.trade.toLowerCase().includes('floor')) ||
          (lower.includes('drywall') && s.trade.toLowerCase().includes('drywall')) ||
          (lower.includes('paint') && s.trade.toLowerCase().includes('paint')) ||
          (lower.includes('detach') && s.trade.toLowerCase().includes('detach')) ||
          (lower.includes('carpen') && s.trade.toLowerCase().includes('carpen')) ||
          (lower.includes('plumb') && s.trade.toLowerCase().includes('plumb'))
        ) || subcontractors[0];

        return {
          tradeName: tg.tradeName,
          subId: matched?.id || subcontractors[0]?.id || '',
          scheduledDate: new Date().toISOString().split('T')[0],
          tasks: tg.tasks,
          isCreated: false
        };
      });

      setTradeAssignments(initialAssignments);

    } catch (err: any) {
      setErrorMsg(err.message || 'An error occurred during extraction.');
    } finally {
      setIsProcessing(false);
    }
  };

  // Create & Dispatch Trade Work Orders
  const handleCreateAllWorkOrders = async () => {
    if (!createdJob) return;
    setIsCreatingWorkOrders(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const updated = [...tradeAssignments];

      for (let i = 0; i < updated.length; i++) {
        const item = updated[i];
        if (item.isCreated) continue;

        const sub = subcontractors.find(s => s.id === item.subId);

        const { ok, data } = await safeFetchJson<any>('/api/work-orders', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jobId: createdJob.id,
            trade: item.tradeName,
            unitArea: createdJob.scopeSummary || 'Main Level',
            assignedSubId: item.subId,
            subName: sub ? sub.company : 'Assigned Subcontractor',
            subPhone: sub ? sub.phone : '',
            scheduledDate: item.scheduledDate,
            tasks: item.tasks
          })
        });

        if (ok && data?.success && data.workOrder) {
          item.isCreated = true;
          item.createdWoId = data.workOrder.woId;
          await onWorkOrderCreated(data.workOrder);
        }
      }

      setTradeAssignments(updated);

      if (onNavigateToJobsDashboard) {
        setTimeout(() => {
          onNavigateToJobsDashboard();
        }, 1200);
      }
    } catch (err: any) {
      alert('Error creating work orders: ' + err.message);
    } finally {
      setIsCreatingWorkOrders(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      
      {/* Header */}
      <div>
        <h1 className="text-xl font-black text-slate-900">Upload Estimate & Create Job</h1>
        <p className="text-xs text-slate-500 mt-1">
          Upload an estimate document. The app automatically extracts customer details, creates the job, and lets you assign trade work orders to subcontractors.
        </p>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* STEP 1: UPLOAD BOX (shown if Job not yet created) */}
      {!createdJob ? (
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs space-y-5">
          
          {/* Drag & Drop Area */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                const f = e.dataTransfer.files[0];
                setFile(f);
                processEstimate(f);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition ${
              isDragOver 
                ? 'border-[#C81D25] bg-red-50/50' 
                : 'border-slate-300 hover:border-slate-400 bg-slate-50/50'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.doc,.docx"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  const f = e.target.files[0];
                  setFile(f);
                  processEstimate(f);
                }
              }}
            />

            {isProcessing ? (
              <div className="space-y-3 py-4">
                <Clock className="w-8 h-8 text-[#C81D25] animate-spin mx-auto" />
                <p className="text-sm font-bold text-slate-800">
                  Extracting customer details & creating job...
                </p>
                <p className="text-xs text-slate-500">
                  Parsing customer name, property address, claim #, and trade scope
                </p>
              </div>
            ) : (
              <div className="space-y-2 py-4">
                <FileUp className="w-10 h-10 text-slate-400 mx-auto" />
                <h3 className="text-sm font-bold text-slate-800">
                  Drop your estimate PDF here or click to browse
                </h3>
                <p className="text-xs text-slate-500">
                  Supports Xactimate, Symbility, PDF, or text estimates
                </p>
              </div>
            )}
          </div>

          {/* Quick Actions / Paste Alternative */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <span className="text-xs text-slate-500 font-medium">
              Have text from Xactimate, Symbility, or email?
            </span>

            <button
              type="button"
              onClick={() => setShowPasteText(!showPasteText)}
              className="text-xs text-[#C81D25] hover:text-[#A8151D] font-bold"
            >
              {showPasteText ? 'Hide text box' : 'Paste estimate text instead'}
            </button>
          </div>

          {showPasteText && (
            <div className="space-y-2 pt-2">
              <textarea
                rows={6}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste estimate details here..."
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
              />
              <button
                type="button"
                disabled={isProcessing || !pasteText.trim()}
                onClick={() => processEstimate(null, pasteText)}
                className="px-4 py-2 rounded-xl bg-[#C81D25] hover:bg-[#A8151D] text-white text-xs font-bold disabled:opacity-50"
              >
                {isProcessing ? 'Processing...' : 'Process Pasted Estimate'}
              </button>
            </div>
          )}

        </div>
      ) : (
        /* STEP 2: JOB CREATED & WORK ORDERS DISPATCH */
        <div className="space-y-5">
          
          {/* Customer Details & Job Card */}
          <div className="bg-white rounded-2xl p-5 border border-emerald-200 bg-emerald-50/20 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <span className="text-sm font-black text-slate-900">
                  Job Created Successfully (#{createdJob.id})
                </span>
              </div>
              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                Extracted
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
              <div className="bg-white p-3 rounded-xl border border-slate-200 space-y-0.5">
                <span className="text-slate-400 text-[10px] uppercase font-bold block">Customer</span>
                <span className="font-black text-slate-900 text-sm block">{createdJob.customerName}</span>
                {createdJob.phone && <span className="text-slate-500 text-[11px]">{createdJob.phone}</span>}
              </div>

              <div className="bg-white p-3 rounded-xl border border-slate-200 space-y-0.5">
                <span className="text-slate-400 text-[10px] uppercase font-bold block">Property Address</span>
                <span className="font-bold text-slate-800 block">{createdJob.propertyAddress}</span>
              </div>

              <div className="bg-white p-3 rounded-xl border border-slate-200 space-y-0.5">
                <span className="text-slate-400 text-[10px] uppercase font-bold block">Claim & Estimate</span>
                <span className="font-mono font-bold text-slate-800 block">Claim: {createdJob.claimNumber}</span>
                {createdJob.totalEstimate && (
                  <span className="text-emerald-600 font-bold block">{createdJob.totalEstimate}</span>
                )}
              </div>
            </div>
          </div>

          {/* Trade Work Orders to Create */}
          <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs space-y-4">
            <div>
              <h2 className="text-sm font-black text-slate-900">
                Work Orders for this Job ({tradeAssignments.length})
              </h2>
              <p className="text-xs text-slate-500">
                Assign each trade scope to a specific subcontractor. They will see these work orders on their dashboard and add photos to the job.
              </p>
            </div>

            <div className="space-y-3">
              {tradeAssignments.map((assignment, idx) => (
                <div 
                  key={idx}
                  className={`p-4 rounded-xl border transition ${
                    assignment.isCreated 
                      ? 'bg-emerald-50/40 border-emerald-200' 
                      : 'bg-white border-slate-200'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-2.5">
                    <div>
                      <span className="text-xs font-black text-slate-900 block">
                        {idx + 1}. {assignment.tradeName}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {assignment.tasks.length} photo checklist tasks
                      </span>
                    </div>

                    {assignment.isCreated ? (
                      <span className="px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-800 font-mono text-xs font-bold flex items-center gap-1 self-start sm:self-auto">
                        <Check className="w-3.5 h-3.5" />
                        <span>Assigned ({assignment.createdWoId})</span>
                      </span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <select
                          value={assignment.subId}
                          onChange={(e) => {
                            const copy = [...tradeAssignments];
                            copy[idx].subId = e.target.value;
                            setTradeAssignments(copy);
                          }}
                          className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 font-semibold focus:outline-none focus:ring-1 focus:ring-[#C81D25]"
                        >
                          {subcontractors.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.company} ({s.trade})
                            </option>
                          ))}
                        </select>

                        <input
                          type="date"
                          value={assignment.scheduledDate}
                          onChange={(e) => {
                            const copy = [...tradeAssignments];
                            copy[idx].scheduledDate = e.target.value;
                            setTradeAssignments(copy);
                          }}
                          className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-[#C81D25]"
                        />

                        <button
                          type="button"
                          onClick={() => {
                            setTradeAssignments(tradeAssignments.filter((_, i) => i !== idx));
                          }}
                          className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition"
                          title="Remove Trade Scope"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Tasks Preview */}
                  <ul className="space-y-1 text-xs text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                    {assignment.tasks.map((task, tIdx) => (
                      <li key={tIdx} className="flex items-start gap-1.5">
                        <span className="text-[10px] text-slate-400 font-mono mt-0.5">•</span>
                        <span>{task}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {/* Action buttons */}
            <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  setCreatedJob(null);
                  setTradeAssignments([]);
                }}
                className="text-xs text-slate-500 hover:text-slate-800 font-semibold"
              >
                Upload another estimate
              </button>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                {onNavigateToJobsDashboard && (
                  <button
                    type="button"
                    onClick={onNavigateToJobsDashboard}
                    className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold transition flex-1 sm:flex-initial"
                  >
                    View in Jobs Dashboard
                  </button>
                )}

                <button
                  type="button"
                  disabled={isCreatingWorkOrders || tradeAssignments.every(t => t.isCreated)}
                  onClick={handleCreateAllWorkOrders}
                  className="px-5 py-2 rounded-xl bg-[#C81D25] hover:bg-[#A8151D] text-white text-xs font-bold shadow-sm transition disabled:opacity-50 flex items-center justify-center gap-1.5 flex-1 sm:flex-initial"
                >
                  <ArrowRight className="w-4 h-4" />
                  <span>
                    {isCreatingWorkOrders 
                      ? 'Creating Work Orders...' 
                      : tradeAssignments.every(t => t.isCreated)
                        ? 'All Work Orders Created'
                        : 'Create & Assign Work Orders'}
                  </span>
                </button>
              </div>
            </div>

          </div>

        </div>
      )}

    </div>
  );
};
