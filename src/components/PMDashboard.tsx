import React, { useState, useEffect, useCallback } from 'react';
import { 
  Users, 
  HardHat, 
  ClipboardList, 
  Activity, 
  Plus, 
  Search, 
  Filter, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  Phone, 
  Mail, 
  MapPin, 
  Calendar, 
  ChevronRight, 
  Trash2, 
  FileUp, 
  Check, 
  Eye, 
  Wrench, 
  UserCheck, 
  X,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
  FolderKanban
} from 'lucide-react';
import { WorkOrder, User, ActivityEvent, SubcontractorSummary, Job } from '../types';
import { safeFetchJson } from '../utils/api';
import { formatClock, formatWhen } from '../utils/time';

interface PMDashboardProps {
  currentUser: User | null;
  authToken: string | null;
  workOrders: WorkOrder[];
  onOpenCreateWorkOrderForSub: (subId: string, subCompany: string, subPhone?: string) => void;
  onSwitchToSubView: (subUser: User, woId?: string, previewToken?: string) => void;
  onOpenAuthModal: () => void;
  onSelectWorkOrderForInspection: (woId: string) => void;
  onNavigateToUploadEstimate?: () => void;
  onRefreshWorkOrders?: () => void;
}

export const PMDashboard: React.FC<PMDashboardProps> = ({
  currentUser,
  authToken,
  workOrders,
  onOpenCreateWorkOrderForSub,
  onSwitchToSubView,
  onOpenAuthModal,
  onSelectWorkOrderForInspection,
  onNavigateToUploadEstimate,
  onRefreshWorkOrders
}) => {
  const [activeTab, setActiveTab] = useState<'jobs' | 'subcontractors' | 'photos'>('jobs');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [subcontractors, setSubcontractors] = useState<SubcontractorSummary[]>([]);
  const [activityFeed, setActivityFeed] = useState<ActivityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // New Work Order Modal
  const [showAddWoModal, setShowAddWoModal] = useState(false);
  const [selectedJobForWo, setSelectedJobForWo] = useState<Job | null>(null);
  const [woForm, setWoForm] = useState({
    jobId: '',
    trade: 'Flooring & Subfloor Restoration',
    unitArea: 'Main Level',
    assignedSubId: '',
    scheduledDate: new Date().toISOString().split('T')[0],
    tasks: [
      'Inspect job area and document pre-existing conditions',
      'Execute trade scope items according to restoration specifications',
      'Clean and remove all debris upon completion'
    ]
  });
  const [newTaskInput, setNewTaskInput] = useState('');
  const [isSubmittingWo, setIsSubmittingWo] = useState(false);

  // New Subcontractor Modal
  const [showAddSubModal, setShowAddSubModal] = useState(false);
  const [newSubForm, setNewSubForm] = useState({
    name: '',
    company: '',
    trade: 'Drywall, Finishing & Painting',
    email: '',
    phone: '',
    password: ''
  });
  const [isSubmittingSub, setIsSubmittingSub] = useState(false);

  // Photo viewer modal
  const [selectedPhoto, setSelectedPhoto] = useState<{
    url: string;
    title: string;
    notes?: string;
    sub?: string;
    lineId?: string;
    woId?: string;
    reviewStatus?: string;
    reviewNote?: string;
    reviewedBy?: string;
    submittedAt?: string;
  } | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [isReviewingPhoto, setIsReviewingPhoto] = useState(false);

  // Per-trade dispatch report ("Auto-generate trade work orders"), keyed to the
  // job it was run for so the report shows up under the right card.
  const [dispatchResults, setDispatchResults] = useState<{
    jobId: string;
    items: { trade: string; outcome: 'created' | 'duplicate' | 'unassigned' | 'failed'; detail: string }[];
  } | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);

  // One-time credentials handed back by the PM crew-onboarding endpoint
  const [createdCredential, setCreatedCredential] = useState<
    { sub: SubcontractorSummary; password: string } | null
  >(null);

  // Fetch Jobs
  const fetchJobs = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const { ok, data } = await safeFetchJson<any>('/api/jobs', { headers });
      if (ok && data?.success && Array.isArray(data.jobs)) {
        setJobs(data.jobs);
      }
    } catch (err) {
      console.error('Failed to fetch jobs:', err);
    }
  }, [authToken]);

  // Fetch Subcontractors
  const fetchSubcontractors = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const { ok, data } = await safeFetchJson<any>('/api/pm/subcontractors', { headers });
      if (ok && data?.success && Array.isArray(data.subcontractors)) {
        setSubcontractors(data.subcontractors);
      }
    } catch (err) {
      console.error('Failed to fetch subcontractors:', err);
    }
  }, [authToken]);

  // Fetch Photos & Activity
  const fetchActivityFeed = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const { ok, data } = await safeFetchJson<any>('/api/pm/activity-feed', { headers });
      if (ok && data?.success && Array.isArray(data.events)) {
        setActivityFeed(data.events);
      }
    } catch (err) {
      console.error('Failed to fetch activity feed:', err);
    }
  }, [authToken]);

  // Initial load
  useEffect(() => {
    const loadAll = async () => {
      setIsLoading(true);
      await Promise.all([fetchJobs(), fetchSubcontractors(), fetchActivityFeed()]);
      setIsLoading(false);
    };
    loadAll();

    const timer = setInterval(() => {
      fetchActivityFeed();
    }, 4000);
    return () => clearInterval(timer);
  }, [fetchJobs, fetchSubcontractors, fetchActivityFeed]);

  // Open modal to add a work order for a job
  const handleOpenAddWoModal = (job: Job) => {
    setSelectedJobForWo(job);
    // Pre-populate every extracted task: silently keeping only the first four
    // dropped scope items the crew was still expected to photograph.
    const initialTasks = job.extractedTasks && job.extractedTasks.length > 0
      ? [...job.extractedTasks]
      : [
          'Inspect job area and document pre-existing conditions',
          'Execute trade scope items according to restoration specifications',
          'Clean and remove all debris upon completion'
        ];

    setWoForm({
      jobId: job.id,
      trade: 'Flooring & Subfloor Restoration',
      unitArea: job.scopeSummary || 'Main Level',
      assignedSubId: '',
      scheduledDate: new Date().toISOString().split('T')[0],
      tasks: initialTasks
    });
    setShowAddWoModal(true);
  };

  // Submit new Work Order
  const handleCreateWorkOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!woForm.jobId || woForm.tasks.length === 0) return;

    setIsSubmittingWo(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const selectedSub = subcontractors.find(s => s.id === woForm.assignedSubId);

      const { ok, data } = await safeFetchJson<any>('/api/work-orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jobId: woForm.jobId,
          trade: woForm.trade,
          unitArea: woForm.unitArea,
          assignedSubId: woForm.assignedSubId || '',
          subName: selectedSub ? selectedSub.company : '',
          subPhone: selectedSub ? selectedSub.phone : '',
          scheduledDate: woForm.scheduledDate,
          tasks: woForm.tasks
        })
      });

      if (ok && data?.success) {
        setShowAddWoModal(false);
        if (data.duplicate) {
          alert(
            `${data.message || 'This scope is already dispatched.'}\n\n` +
            `Open Work Order #${data.woId} to review it, or ask for "Dispatch anyway" if a second crew or a new date was intended.`
          );
        }
        await Promise.all([fetchJobs(), fetchSubcontractors()]);
        if (onRefreshWorkOrders) onRefreshWorkOrders();
      } else {
        alert(data?.error || 'Failed to create work order');
      }
    } catch (err: any) {
      alert('Error creating work order: ' + err.message);
    } finally {
      setIsSubmittingWo(false);
    }
  };

  // Delete Work Order
  const handleDeleteWo = async (woId: string) => {
    if (!confirm(`Delete Work Order ${woId}? This will remove it from the system and Google Sheets.`)) return;
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      if (currentUser?.id) headers['X-User-Id'] = currentUser.id;
      const { ok, data } = await safeFetchJson<any>(`/api/work-orders/${encodeURIComponent(woId)}`, {
        method: 'DELETE',
        headers
      });
      if (ok && data?.success) {
        await Promise.all([fetchJobs(), fetchSubcontractors()]);
        if (onRefreshWorkOrders) onRefreshWorkOrders();
      } else {
        alert(data?.error || 'Failed to delete work order');
      }
    } catch (err: any) {
      console.error('Failed to delete work order:', err);
      alert('Error deleting work order: ' + err.message);
    }
  };

  // Delete Job
  const handleDeleteJob = async (jobId: string) => {
    if (!confirm(`Delete Job ${jobId} and all associated work orders? This will remove them from the system and Google Sheets.`)) return;
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      if (currentUser?.id) headers['X-User-Id'] = currentUser.id;
      const { ok, data } = await safeFetchJson<any>(`/api/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers
      });
      if (ok && data?.success) {
        await Promise.all([fetchJobs(), fetchSubcontractors()]);
        if (onRefreshWorkOrders) onRefreshWorkOrders();
      } else {
        alert(data?.error || 'Failed to delete job');
      }
    } catch (err: any) {
      console.error('Failed to delete job:', err);
      alert('Error deleting job: ' + err.message);
    }
  };

  // Delete Subcontractor (PM only)
  const handleDeleteSub = async (subId: string, companyName: string) => {
    if (!confirm(`Delete subcontractor "${companyName}"? This will remove them from the system and Google Sheets.`)) return;
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      if (currentUser?.id) headers['X-User-Id'] = currentUser.id;
      const { ok, data } = await safeFetchJson<any>(`/api/pm/subcontractors/${encodeURIComponent(subId)}`, {
        method: 'DELETE',
        headers
      });
      if (ok && data?.success) {
        await fetchSubcontractors();
      } else {
        alert(data?.error || 'Failed to delete subcontractor');
      }
    } catch (err: any) {
      alert('Error deleting subcontractor: ' + err.message);
    }
  };

  // 1-Click Generate Trade Work Orders from Job Extracted Scope
  const handleGenerateTradeWorkOrders = async (job: Job) => {
    if (!job.extractedTrades || job.extractedTrades.length === 0) return;
    if (subcontractors.length === 0) {
      alert('Please create at least one subcontractor in the Subcontractors tab first before dispatching trade work orders.');
      setActiveTab('subcontractors');
      return;
    }
    const confirmText = `Auto-generate ${job.extractedTrades.length} individual work orders for this job from the estimate trade breakdown?`;
    if (!confirm(confirmText)) return;

    setIsDispatching(true);
    setDispatchResults(null);
    const results: { trade: string; outcome: 'created' | 'duplicate' | 'unassigned' | 'failed'; detail: string }[] = [];

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      for (const tradeGroup of job.extractedTrades) {
        // Find best sub match. A trade with no matching crew is reported, never
        // silently handed to an unrelated subcontractor.
        const lowerTrade = tradeGroup.tradeName.toLowerCase();
        const matchedSub = subcontractors.find(s =>
          (lowerTrade.includes('floor') && s.trade.toLowerCase().includes('floor')) ||
          (lowerTrade.includes('drywall') && s.trade.toLowerCase().includes('drywall')) ||
          (lowerTrade.includes('carpen') && s.trade.toLowerCase().includes('carpen')) ||
          (lowerTrade.includes('paint') && s.trade.toLowerCase().includes('paint')) ||
          (lowerTrade.includes('plumb') && s.trade.toLowerCase().includes('plumb')) ||
          (lowerTrade.includes('elect') && s.trade.toLowerCase().includes('elect')) ||
          (lowerTrade.includes('mechanical') && s.trade.toLowerCase().includes('mechanical')) ||
          (lowerTrade.includes('content') && s.trade.toLowerCase().includes('content')) ||
          (lowerTrade.includes('demolition') && s.trade.toLowerCase().includes('demo')) ||
          (lowerTrade.includes('clean') && s.trade.toLowerCase().includes('clean'))
        );

        if (!matchedSub) {
          results.push({
            trade: tradeGroup.tradeName,
            outcome: 'unassigned',
            detail: 'No crew with a matching trade - work order not dispatched.'
          });
          continue;
        }

        const { ok, data } = await safeFetchJson<any>('/api/work-orders', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jobId: job.id,
            trade: tradeGroup.tradeName,
            unitArea: job.scopeSummary || 'Main Level',
            assignedSubId: matchedSub.id,
            subName: matchedSub.company,
            subPhone: matchedSub.phone,
            scheduledDate: new Date().toISOString().split('T')[0],
            tasks: tradeGroup.tasks
          })
        });

        if (ok && data?.success && data.duplicate) {
          results.push({
            trade: tradeGroup.tradeName,
            outcome: 'duplicate',
            detail: `Already dispatched as #${data.woId}.`
          });
        } else if (ok && data?.success) {
          results.push({
            trade: tradeGroup.tradeName,
            outcome: 'created',
            detail: `Work Order #${data.workOrder?.woId || ''} assigned to ${matchedSub.company}.`
          });
        } else {
          results.push({
            trade: tradeGroup.tradeName,
            outcome: 'failed',
            detail: data?.error || 'The server rejected this work order.'
          });
        }
      }

      setDispatchResults({ jobId: job.id, items: results });
      await Promise.all([fetchJobs(), fetchSubcontractors()]);
      if (onRefreshWorkOrders) onRefreshWorkOrders();
    } catch (err: any) {
      setDispatchResults({ jobId: job.id, items: results });
      alert('Error generating trade work orders: ' + err.message);
    } finally {
      setIsDispatching(false);
    }
  };

  // Create new Subcontractor (PM-authenticated onboarding, one-time credential)
  const handleCreateSub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubForm.name || !newSubForm.company || !newSubForm.email) return;

    const suppliedPassword = newSubForm.password.trim();
    if (suppliedPassword && suppliedPassword.length < 8) {
      alert('A password you set yourself must be at least 8 characters. Leave the field blank to let the app generate a one-time password instead.');
      return;
    }

    setIsSubmittingSub(true);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (currentUser?.id) headers['X-User-Id'] = currentUser.id;

    const { ok, data, error } = await safeFetchJson<any>('/api/pm/subcontractors', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: newSubForm.name,
        company: newSubForm.company,
        trade: newSubForm.trade,
        email: newSubForm.email,
        phone: newSubForm.phone,
        password: suppliedPassword || undefined
      })
    });

    setIsSubmittingSub(false);
    if (ok && data?.success) {
      setShowAddSubModal(false);
      setCreatedCredential({
        sub: data.subcontractor,
        password: data.subcontractor?.tempPassword || suppliedPassword
      });
      setNewSubForm({
        name: '',
        company: '',
        trade: 'Drywall, Finishing & Painting',
        email: '',
        phone: '',
        password: ''
      });
      await fetchSubcontractors();
    } else {
      alert(error || data?.error || 'Failed to register subcontractor');
    }
  };

  // Preview the field portal as a crew (audited, expires automatically)
  const handlePreviewAsSub = async (sub: SubcontractorSummary, woId?: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (currentUser?.id) headers['X-User-Id'] = currentUser.id;

    const { ok, data, error } = await safeFetchJson<any>('/api/pm/view-as-sub', {
      method: 'POST',
      headers,
      body: JSON.stringify({ subId: sub.id, woId })
    });

    if (ok && data?.success && data.user) {
      onSwitchToSubView(data.user as User, woId, data.token as string);
    } else {
      alert(error || data?.error || 'Could not open the subcontractor preview.');
    }
  };

  // Approve or send back a field photo (PM review loop)
  const handleReviewPhoto = async (decision: 'approve' | 'reject') => {
    if (!selectedPhoto?.woId || !selectedPhoto?.lineId) return;
    const note = reviewNote.trim();
    if (decision === 'reject' && !note) {
      alert('Add a short note so the crew knows what to fix before you request a retake.');
      return;
    }

    setIsReviewingPhoto(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const { ok, data } = await safeFetchJson<any>(
        `/api/work-orders/${encodeURIComponent(selectedPhoto.woId)}/line-items/${encodeURIComponent(selectedPhoto.lineId)}/review`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ decision, note })
        }
      );

      if (ok && data?.success) {
        setSelectedPhoto(null);
        setReviewNote('');
        await fetchActivityFeed();
        await fetchSubcontractors();
        if (onRefreshWorkOrders) onRefreshWorkOrders();
      } else {
        alert(data?.error || 'Could not record the review.');
      }
    } catch (err: any) {
      alert('Error recording review: ' + err.message);
    } finally {
      setIsReviewingPhoto(false);
    }
  };

  // Filter jobs
  const filteredJobs = jobs.filter(j => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      j.customerName.toLowerCase().includes(q) ||
      j.propertyAddress.toLowerCase().includes(q) ||
      (j.claimNumber && j.claimNumber.toLowerCase().includes(q)) ||
      j.id.toLowerCase().includes(q)
    );
  });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      
      {/* Top Operations Header */}
      <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-black text-slate-900 leading-tight">Project Management</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Extract estimates, create jobs, assign trade work orders, and verify field photos.
          </p>
        </div>

        <div className="flex items-center gap-2.5 w-full sm:w-auto">
          {onNavigateToUploadEstimate && (
            <button
              onClick={onNavigateToUploadEstimate}
              className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-[#C81D25] hover:bg-[#A8151D] text-white text-xs font-bold shadow-sm transition active:scale-95 flex-1 sm:flex-initial"
            >
              <FileUp className="w-4 h-4" />
              <span>Upload Estimate</span>
            </button>
          )}

          <button
            onClick={() => setShowAddSubModal(true)}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-sm transition"
          >
            <Plus className="w-4 h-4" />
            <span>Add Sub</span>
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2 overflow-x-auto no-scrollbar">
        <button
          onClick={() => setActiveTab('jobs')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition shrink-0 whitespace-nowrap ${
            activeTab === 'jobs'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          <FolderKanban className="w-4 h-4" />
          <span>Jobs & Work Orders ({jobs.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('subcontractors')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition shrink-0 whitespace-nowrap ${
            activeTab === 'subcontractors'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          <HardHat className="w-4 h-4" />
          <span>Subcontractors ({subcontractors.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('photos')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition shrink-0 whitespace-nowrap ${
            activeTab === 'photos'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          <Activity className="w-4 h-4" />
          <span>Photo Stream ({activityFeed.filter(a => a.photoUrl).length})</span>
        </button>
      </div>

      {/* TAB 1: JOBS & WORK ORDERS */}
      {activeTab === 'jobs' && (
        <div className="space-y-4">
          
          {/* Search bar */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search by customer name, address, claim #, or job ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-xl pl-9 pr-4 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#C81D25] shadow-xs"
            />
          </div>

          {isLoading ? (
            <div className="bg-white rounded-2xl p-12 text-center border border-slate-200">
              <Clock className="w-6 h-6 text-slate-400 animate-spin mx-auto mb-2" />
              <p className="text-xs text-slate-500 font-medium">Loading jobs...</p>
            </div>
          ) : filteredJobs.length === 0 ? (
            <div className="bg-white rounded-2xl p-10 text-center border border-slate-200 space-y-3">
              <FolderKanban className="w-10 h-10 text-slate-300 mx-auto" />
              <h3 className="text-sm font-bold text-slate-800">No Jobs Found</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Upload an estimate to extract customer details and automatically create a job.
              </p>
              {onNavigateToUploadEstimate && (
                <button
                  onClick={onNavigateToUploadEstimate}
                  className="px-4 py-2 rounded-xl bg-[#C81D25] text-white font-bold text-xs"
                >
                  Upload Estimate Now
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredJobs.map((job) => {
                const jobWorkOrders = job.workOrders || [];
                const totalTasks = jobWorkOrders.reduce((sum, wo) => sum + (wo.totalItems || 0), 0);
                const completedTasks = jobWorkOrders.reduce((sum, wo) => sum + (wo.completedItems || 0), 0);
                const progressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

                return (
                  <div 
                    key={job.id}
                    className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden transition hover:border-slate-300"
                  >
                    {/* Job Card Header: Customer Details */}
                    <div className="p-4 sm:p-5 bg-slate-50/70 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-black px-2 py-0.5 rounded bg-slate-900 text-white">
                            {job.id}
                          </span>
                          <span className="text-base font-black text-slate-900">
                            {job.customerName}
                          </span>
                          {job.lossType && (
                            <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-800">
                              {job.lossType}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5 text-[#C81D25] shrink-0" />
                            <span>{job.propertyAddress}</span>
                          </span>

                          {job.phone && (
                            <span className="flex items-center gap-1 text-slate-500">
                              <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span>{job.phone}</span>
                            </span>
                          )}

                          {job.claimNumber && (
                            <span className="text-slate-500 font-mono text-[11px]">
                              Claim: <strong className="text-slate-700">{job.claimNumber}</strong>
                            </span>
                          )}

                          {job.totalEstimate && (
                            <span className="text-emerald-700 font-bold">
                              Estimate: {job.totalEstimate}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Job Level Actions */}
                      <div className="flex items-center gap-2 shrink-0">
                        {job.extractedTrades && job.extractedTrades.length > 0 && (
                          <button
                            onClick={() => handleGenerateTradeWorkOrders(job)}
                            disabled={isDispatching}
                            className="px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 disabled:opacity-50 text-[#C81D25] border border-red-200 text-xs font-bold transition"
                            title="Auto-create work orders for all extracted estimate trades"
                          >
                            {isDispatching ? 'Dispatching…' : `+ Auto-Create Trade WOs (${job.extractedTrades.length})`}
                          </button>
                        )}

                        <button
                          onClick={() => handleOpenAddWoModal(job)}
                          className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition flex items-center gap-1"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Add Work Order</span>
                        </button>

                        <button
                          onClick={() => handleDeleteJob(job.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                          title="Delete Job"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Progress summary for this Job */}
                    <div className="px-5 py-2.5 bg-white border-b border-slate-100 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-700">Work Orders ({jobWorkOrders.length}):</span>
                        <span className="text-slate-500">{completedTasks}/{totalTasks} tasks verified ({progressPct}%)</span>
                      </div>
                      <div className="w-32 bg-slate-100 h-2 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full transition-all ${progressPct === 100 ? 'bg-emerald-500' : 'bg-[#C81D25]'}`}
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                    </div>

                    {/* Individual Work Orders List */}
                    <div className="p-4 sm:p-5 space-y-2.5">
                      {jobWorkOrders.length === 0 ? (
                        <div className="py-4 text-center text-xs text-slate-400">
                          No work orders assigned to this job yet. Click "Add Work Order" to assign a subcontractor.
                        </div>
                      ) : (
                        jobWorkOrders.map((wo) => {
                          const woPct = wo.totalItems > 0 ? Math.round((wo.completedItems / wo.totalItems) * 100) : 0;
                          const woSignedOff = Boolean(wo.signedAt);
                          const woAwaitingSignOff = !woSignedOff && wo.totalItems > 0 && wo.completedItems === wo.totalItems;
                          const woStatusLabel = woSignedOff ? 'Signed Off' : (woAwaitingSignOff ? 'Awaiting Sign-Off' : wo.status);
                          return (
                            <div
                              key={wo.woId}
                              className="p-3.5 rounded-xl border border-slate-200 hover:border-slate-300 bg-white flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs"
                            >
                              <div className="space-y-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-xs font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded">
                                    {wo.woId}
                                  </span>
                                  <span className="text-xs font-black text-slate-900">
                                    {wo.trade || wo.projectName}
                                  </span>
                                  <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                                    woSignedOff
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : woAwaitingSignOff || wo.status === 'In Progress'
                                        ? 'bg-amber-100 text-amber-800'
                                        : 'bg-slate-100 text-slate-700'
                                  }`}>
                                    {woStatusLabel}
                                  </span>
                                </div>

                                <div className="flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
                                  <span className="flex items-center gap-1 font-semibold text-slate-700">
                                    <HardHat className="w-3.5 h-3.5 text-[#C81D25]" />
                                    <span>{wo.subName}</span>
                                  </span>
                                  <span>•</span>
                                  <span>Area: {wo.unitArea}</span>
                                  <span>•</span>
                                  <span>{wo.completedItems}/{wo.totalItems} photos</span>
                                </div>
                              </div>

                              {/* Work Order Actions */}
                              <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                                <button
                                  onClick={() => onSelectWorkOrderForInspection(wo.woId)}
                                  className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold transition flex items-center gap-1"
                                  title="View and test photo checklist as subcontractor"
                                >
                                  <Eye className="w-3.5 h-3.5 text-slate-600" />
                                  <span>Sub View</span>
                                </button>

                                <button
                                  onClick={() => handleDeleteWo(wo.woId)}
                                  className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                                  title="Delete Work Order"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Per-trade dispatch report: every trade is accounted for */}
                    {dispatchResults && dispatchResults.jobId === job.id && (
                      <div className="mx-4 sm:mx-5 mb-4 sm:mb-5 rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2">
                        <div className="flex items-center justify-between">
                          <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-700">
                            Dispatch report
                          </h4>
                          <button
                            type="button"
                            onClick={() => setDispatchResults(null)}
                            className="text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-700"
                          >
                            Dismiss
                          </button>
                        </div>
                        <div className="space-y-1.5">
                          {dispatchResults.items.map((result) => (
                            <div
                              key={result.trade}
                              className="flex items-start gap-2 text-[11px] bg-white rounded-lg border border-slate-100 px-2.5 py-2"
                            >
                              <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider ${
                                result.outcome === 'created'
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : (result.outcome === 'duplicate'
                                    ? 'bg-amber-100 text-amber-700'
                                    : (result.outcome === 'unassigned'
                                      ? 'bg-slate-200 text-slate-700'
                                      : 'bg-red-100 text-red-700'))
                              }`}>
                                {result.outcome === 'created' ? 'Dispatched' : result.outcome}
                              </span>
                              <div className="min-w-0">
                                <p className="font-bold text-slate-800">{result.trade}</p>
                                <p className="text-slate-500">{result.detail}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                        {dispatchResults.items.some(r => r.outcome === 'unassigned') && (
                          <p className="text-[10px] text-slate-500">
                            Trades with no matching crew can be dispatched manually with “Add Work Order”.
                          </p>
                        )}
                      </div>
                    )}

                  </div>
                );
              })}
            </div>
          )}

        </div>
      )}

      {/* TAB 2: SUBCONTRACTORS DIRECTORY */}
      {activeTab === 'subcontractors' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <div>
              <h2 className="text-sm font-black text-slate-900">Subcontractor Trade Directory</h2>
              <p className="text-xs text-slate-500">Create subcontractor logins and manage trade partner mobile access.</p>
            </div>
            <button
              id="btn-open-create-sub-modal"
              type="button"
              onClick={() => setShowAddSubModal(true)}
              className="px-4 py-2 rounded-xl bg-[#C81D25] hover:bg-[#A8151D] text-white text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span>Create Subcontractor Login</span>
            </button>
          </div>

          {/* One-time credentials: shown once, never stored, never emailed */}
          {createdCredential && (
            <div className="bg-white p-4 rounded-2xl border-2 border-emerald-300 shadow-xs space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-black text-slate-900">
                    Field login created for {createdCredential.sub.company}
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Hand these to the crew now — the password is shown once and the app never stores
                    it in readable form.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCreatedCredential(null)}
                  className="text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-700"
                >
                  Dismiss
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <div className="bg-slate-50 rounded-xl px-3 py-2">
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">Email</span>
                  <span className="font-mono text-slate-900 break-all">{createdCredential.sub.email}</span>
                </div>
                <div className="bg-slate-50 rounded-xl px-3 py-2">
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">One-time password</span>
                  <span className="font-mono font-black text-slate-900">{createdCredential.password}</span>
                </div>
                <div className="bg-slate-50 rounded-xl px-3 py-2">
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">Sign-in link</span>
                  <span className="font-mono text-slate-900 break-all">{window.location.origin}</span>
                </div>
              </div>
            </div>
          )}

          {subcontractors.length === 0 ? (
            <div className="bg-white rounded-2xl p-10 text-center border border-slate-200 space-y-3">
              <HardHat className="w-10 h-10 text-slate-300 mx-auto" />
              <h3 className="text-sm font-bold text-slate-800">No Subcontractors Created Yet</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Start from scratch: create your trade subcontractor logins so they can sign into the mobile field portal and upload inspection photos.
              </p>
              <button
                type="button"
                onClick={() => setShowAddSubModal(true)}
                className="px-4 py-2 rounded-xl bg-[#C81D25] text-white font-bold text-xs shadow-sm hover:bg-[#A8151D] transition inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Create First Subcontractor Login</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {subcontractors.map((sub) => {
              const activeCount = sub.totalJobs - sub.completedJobs;
              return (
                <div 
                  key={sub.id}
                  className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs flex flex-col justify-between gap-4"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-black text-slate-900">{sub.company}</h3>
                        <p className="text-xs text-slate-500 font-semibold">{sub.name} • {sub.trade}</p>
                      </div>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                        {sub.phone}
                      </span>
                    </div>

                    <div className="pt-2 border-t border-slate-100 grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="bg-slate-50 p-2 rounded-xl">
                        <span className="block font-black text-slate-900 text-sm">{sub.totalJobs}</span>
                        <span className="text-[10px] text-slate-500 font-medium">Assigned</span>
                      </div>
                      <div className="bg-slate-50 p-2 rounded-xl">
                        <span className="block font-black text-emerald-600 text-sm">{sub.completedJobs}</span>
                        <span className="text-[10px] text-slate-500 font-medium">Completed</span>
                      </div>
                      <div className="bg-slate-50 p-2 rounded-xl">
                        <span className="block font-black text-slate-900 text-sm">{sub.completedItems}</span>
                        <span className="text-[10px] text-slate-500 font-medium">Photos Submitted</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <button
                      onClick={() => handlePreviewAsSub(sub)}
                      className="flex-1 py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition flex items-center justify-center gap-1.5"
                    >
                      <HardHat className="w-3.5 h-3.5" />
                      <span>Open Portal as Sub</span>
                    </button>
                    <button
                      type="button"
                      title="Delete Subcontractor"
                      onClick={() => handleDeleteSub(sub.id, sub.company)}
                      className="p-2 rounded-xl border border-slate-200 text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: PHOTO ACTIVITY STREAM */}
      {activeTab === 'photos' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {activityFeed.filter(a => a.photoUrl).map((event) => (
              <div 
                key={event.id}
                onClick={() => setSelectedPhoto({
                  url: event.photoUrl || '',
                  title: event.taskDescription || event.projectName || 'Inspection Photo',
                  notes: event.notes,
                  sub: event.subName,
                  lineId: event.lineId,
                  woId: event.woId,
                  reviewStatus: event.reviewStatus,
                  reviewNote: event.reviewStatus === 'Rejected' ? event.notes : undefined,
                  reviewedBy: event.reviewedBy,
                  submittedAt: event.timestamp
                })}
                className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs hover:shadow-md transition cursor-pointer flex flex-col"
              >
                <div className="aspect-video bg-slate-900 relative overflow-hidden">
                  <img 
                    src={event.photoUrl} 
                    alt="Task photo"
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-slate-950/80 text-white font-mono text-[10px] font-bold">
                    {formatClock(event.timestamp)}
                  </div>
                  {event.reviewStatus && (
                    <div className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider ${
                      event.reviewStatus === 'Approved'
                        ? 'bg-emerald-500 text-white'
                        : (event.reviewStatus === 'Rejected'
                          ? 'bg-red-600 text-white'
                          : 'bg-amber-400 text-slate-950')
                    }`}>
                      {event.reviewStatus}
                    </div>
                  )}
                  {event.type === 'photo_resubmitted' && (
                    <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-slate-950/85 text-amber-300 text-[10px] font-black uppercase tracking-wider">
                      Reshoot
                    </div>
                  )}
                </div>

                <div className="p-3.5 space-y-1 flex-1 flex flex-col justify-between">
                  <div>
                    <h4 className="text-xs font-bold text-slate-900 leading-snug line-clamp-2">
                      {event.taskDescription || event.projectName}
                    </h4>
                    {event.notes && (
                      <p className="text-[11px] text-slate-500 mt-1 italic line-clamp-2">
                        "{event.notes}"
                      </p>
                    )}
                  </div>

                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-600">
                    <span className="font-bold truncate">{event.subName}</span>
                    <span className="font-mono text-slate-400 text-[10px]">{event.woId}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Every logged event, not just the ones with a photo attached: this is
              the audit trail for reviews, sign-offs, dispatches and deletes. */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
                Activity trail ({activityFeed.length})
              </h3>
              <span className="text-[10px] text-slate-400 font-medium">
                Newest first • capped at 250 entries
              </span>
            </div>
            {activityFeed.length === 0 ? (
              <p className="p-4 text-xs text-slate-400">No activity recorded yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                {activityFeed.map((event) => (
                  <li key={`${event.id}-row`} className="px-4 py-2.5 flex items-start gap-3 text-xs">
                    <span className="font-mono text-[10px] text-slate-400 w-24 shrink-0 pt-0.5">
                      {formatClock(event.timestamp)}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider shrink-0 ${
                      event.type === 'wo_completed' || event.type === 'sub_signed_off' || event.type === 'wo_signed_off_by_pm'
                        ? 'bg-emerald-100 text-emerald-700'
                        : (event.type.endsWith('_deleted')
                          ? 'bg-red-100 text-red-700'
                          : (event.type === 'line_item_reviewed' || event.type === 'wo_reopened'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-slate-100 text-slate-600'))
                    }`}>
                      {event.type.replace(/_/g, ' ')}
                    </span>
                    <span className="min-w-0 flex-1 text-slate-600">
                      <strong className="text-slate-900">{event.company || event.subName}</strong>
                      {event.woId ? ` • WO #${event.woId}` : ''}
                      {event.taskDescription ? ` • ${event.taskDescription}` : ''}
                      {event.notes ? <span className="block text-slate-500">{event.notes}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* MODAL: ADD WORK ORDER UNDER JOB */}
      {showAddWoModal && selectedJobForWo && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-black text-slate-900">Add Work Order</h3>
                <p className="text-xs text-slate-500">
                  Job: <strong>{selectedJobForWo.customerName}</strong> ({selectedJobForWo.id})
                </p>
              </div>
              <button
                onClick={() => setShowAddWoModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateWorkOrder} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Trade / Scope Title
                </label>
                <input
                  type="text"
                  value={woForm.trade}
                  onChange={(e) => setWoForm({ ...woForm, trade: e.target.value })}
                  placeholder="e.g. Flooring, Drywall & Paint, Detach & Reset"
                  required
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Work Location / Room
                  </label>
                  <input
                    type="text"
                    value={woForm.unitArea}
                    onChange={(e) => setWoForm({ ...woForm, unitArea: e.target.value })}
                    placeholder="e.g. Main Level, Kitchen"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Scheduled Date
                  </label>
                  <input
                    type="date"
                    value={woForm.scheduledDate}
                    onChange={(e) => setWoForm({ ...woForm, scheduledDate: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Assign Subcontractor
                </label>
                <select
                  value={woForm.assignedSubId}
                  onChange={(e) => setWoForm({ ...woForm, assignedSubId: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 font-semibold focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                >
                  <option value="">— Leave unassigned (dispatch later) —</option>
                  {subcontractors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.company} ({s.trade}) - {s.phone}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-slate-500 mt-1">
                  A work order with no crew cannot be signed off until somebody is assigned.
                </p>
              </div>

              {/* Tasks List */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  Line Item Tasks (Subcontractor Photo Requirements)
                </label>
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {woForm.tasks.map((task, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="text-[11px] font-mono font-bold text-slate-400 w-5">
                        {idx + 1}.
                      </span>
                      <input
                        type="text"
                        value={task}
                        onChange={(e) => {
                          const updated = [...woForm.tasks];
                          updated[idx] = e.target.value;
                          setWoForm({ ...woForm, tasks: updated });
                        }}
                        className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-[#C81D25]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setWoForm({
                            ...woForm,
                            tasks: woForm.tasks.filter((_, i) => i !== idx)
                          });
                        }}
                        className="text-slate-400 hover:text-red-600 p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Add task input */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    placeholder="Add another task..."
                    value={newTaskInput}
                    onChange={(e) => setNewTaskInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (newTaskInput.trim()) {
                          setWoForm({ ...woForm, tasks: [...woForm.tasks, newTaskInput.trim()] });
                          setNewTaskInput('');
                        }
                      }
                    }}
                    className="flex-1 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-[#C81D25]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (newTaskInput.trim()) {
                        setWoForm({ ...woForm, tasks: [...woForm.tasks, newTaskInput.trim()] });
                        setNewTaskInput('');
                      }
                    }}
                    className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-lg"
                  >
                    Add
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddWoModal(false)}
                  className="px-3.5 py-2 rounded-xl text-slate-600 hover:bg-slate-100 text-xs font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingWo || woForm.tasks.length === 0}
                  className="px-4 py-2 rounded-xl bg-[#C81D25] hover:bg-[#A8151D] text-white text-xs font-bold shadow-sm transition disabled:opacity-50"
                >
                  {isSubmittingWo ? 'Assigning...' : 'Assign Work Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ADD SUBCONTRACTOR */}
      {showAddSubModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-black text-slate-900">Add Subcontractor</h3>
              <button
                onClick={() => setShowAddSubModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSub} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Company Name</label>
                <input
                  type="text"
                  value={newSubForm.company}
                  onChange={(e) => setNewSubForm({ ...newSubForm, company: e.target.value })}
                  placeholder="e.g. Precision Flooring LLC"
                  required
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Contact Name</label>
                <input
                  type="text"
                  value={newSubForm.name}
                  onChange={(e) => setNewSubForm({ ...newSubForm, name: e.target.value })}
                  placeholder="e.g. John Smith"
                  required
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Trade Specialization</label>
                <input
                  type="text"
                  value={newSubForm.trade}
                  onChange={(e) => setNewSubForm({ ...newSubForm, trade: e.target.value })}
                  placeholder="e.g. Flooring & Subfloor, Drywall, Plumbing"
                  required
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={newSubForm.email}
                    onChange={(e) => setNewSubForm({ ...newSubForm, email: e.target.value })}
                    placeholder="sub@example.com"
                    required
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Phone</label>
                  <input
                    type="tel"
                    value={newSubForm.phone}
                    onChange={(e) => setNewSubForm({ ...newSubForm, phone: e.target.value })}
                    placeholder="(260) 555-0123"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Initial Subcontractor Password
                </label>
                <input
                  type="text"
                  value={newSubForm.password}
                  onChange={(e) => setNewSubForm({ ...newSubForm, password: e.target.value })}
                  placeholder="Leave blank to auto-generate"
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Leave blank to auto-generate a secure temporary password. Share it with the subcontractor so they can sign into the mobile field portal.
                </p>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddSubModal(false)}
                  className="px-3.5 py-2 rounded-xl text-slate-600 hover:bg-slate-100 text-xs font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingSub}
                  className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-sm transition"
                >
                  {isSubmittingSub ? 'Saving...' : 'Add Subcontractor'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: PHOTO VIEWER */}
      {selectedPhoto && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-xl w-full overflow-hidden shadow-2xl space-y-3">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h4 className="text-xs font-black text-slate-900">{selectedPhoto.title}</h4>
                <p className="text-[11px] text-slate-500">
                  {selectedPhoto.sub ? `Submitted by ${selectedPhoto.sub}` : 'Submitted by crew'}
                  {selectedPhoto.submittedAt ? ` • ${formatWhen(selectedPhoto.submittedAt)}` : ''}
                  {selectedPhoto.woId ? ` • WO #${selectedPhoto.woId}` : ''}
                </p>
              </div>
              <button
                onClick={() => {
                  setSelectedPhoto(null);
                  setReviewNote('');
                }}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="max-h-[65vh] bg-slate-900 overflow-hidden flex items-center justify-center">
              <img 
                src={selectedPhoto.url} 
                alt="Enlarged inspection" 
                className="max-h-[65vh] w-auto object-contain"
                referrerPolicy="no-referrer"
              />
            </div>
            {selectedPhoto.notes && (
              <div className="p-4 bg-slate-50 text-xs text-slate-700">
                <strong>Notes:</strong> {selectedPhoto.notes}
              </div>
            )}

            {/* PM review round: a rejected shot sends the crew back for a reshoot */}
            {selectedPhoto.lineId && selectedPhoto.woId && (
              <div className="px-4 pb-4 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  <span>Inspection review</span>
                  <span className={`px-2 py-0.5 rounded-full ${
                    selectedPhoto.reviewStatus === 'Approved'
                      ? 'bg-emerald-100 text-emerald-700'
                      : (selectedPhoto.reviewStatus === 'Rejected'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-amber-100 text-amber-700')
                  }`}>
                    {selectedPhoto.reviewStatus || 'Pending Review'}
                  </span>
                </div>
                {selectedPhoto.reviewedBy && selectedPhoto.reviewStatus !== 'Pending Review' && (
                  <p className="text-[11px] text-slate-500">
                    Decided by {selectedPhoto.reviewedBy}
                  </p>
                )}
                {selectedPhoto.reviewNote && (
                  <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">
                    <strong>Rejection note:</strong> {selectedPhoto.reviewNote}
                  </p>
                )}
                <textarea
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  rows={2}
                  placeholder="Why is this photo not acceptable? (required to request a reshoot)"
                  className="w-full text-xs border border-slate-200 rounded-xl p-2.5 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                />
                <div className="flex items-center gap-2">
                  <button
                    disabled={isReviewingPhoto}
                    onClick={() => handleReviewPhoto('approve')}
                    className="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-xs transition"
                  >
                    {isReviewingPhoto ? 'Saving…' : 'Approve photo'}
                  </button>
                  <button
                    disabled={isReviewingPhoto || !reviewNote.trim()}
                    onClick={() => handleReviewPhoto('reject')}
                    className="flex-1 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-bold text-xs transition"
                  >
                    Request reshoot
                  </button>
                </div>
                <p className="text-[10px] text-slate-400">
                  Sign-off requires a photo for every task. Requesting a reshoot reopens the work
                  order so the crew can replace this shot.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
};
