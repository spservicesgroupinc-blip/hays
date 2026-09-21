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

interface PMDashboardProps {
  currentUser: User | null;
  authToken: string | null;
  workOrders: WorkOrder[];
  onOpenCreateWorkOrderForSub: (subId: string, subCompany: string, subPhone?: string) => void;
  onSwitchToSubView: (subUser: User, woId?: string) => void;
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
    password: 'Password123!'
  });
  const [isSubmittingSub, setIsSubmittingSub] = useState(false);

  // Photo viewer modal
  const [selectedPhoto, setSelectedPhoto] = useState<{ url: string; title: string; notes?: string; sub?: string } | null>(null);

  // Fetch Jobs
  const fetchJobs = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const res = await fetch('/api/jobs', { headers });
      const data = await res.json();
      if (data.success && Array.isArray(data.jobs)) {
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
      const res = await fetch('/api/pm/subcontractors', { headers });
      const data = await res.json();
      if (data.success && Array.isArray(data.subcontractors)) {
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
      const res = await fetch('/api/pm/activity-feed', { headers });
      const data = await res.json();
      if (data.success && Array.isArray(data.events)) {
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
    // Pre-populate tasks from job scope if available
    const initialTasks = job.extractedTasks && job.extractedTasks.length > 0 
      ? job.extractedTasks.slice(0, 4)
      : [
          'Inspect job area and document pre-existing conditions',
          'Execute trade scope items according to restoration specifications',
          'Clean and remove all debris upon completion'
        ];

    setWoForm({
      jobId: job.id,
      trade: 'Flooring & Subfloor Restoration',
      unitArea: job.scopeSummary || 'Main Level',
      assignedSubId: subcontractors[0]?.id || '',
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

      const res = await fetch('/api/work-orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jobId: woForm.jobId,
          trade: woForm.trade,
          unitArea: woForm.unitArea,
          assignedSubId: woForm.assignedSubId,
          subName: selectedSub ? selectedSub.company : 'Assigned Subcontractor',
          subPhone: selectedSub ? selectedSub.phone : '',
          scheduledDate: woForm.scheduledDate,
          tasks: woForm.tasks
        })
      });

      const data = await res.json();
      if (data.success) {
        setShowAddWoModal(false);
        await Promise.all([fetchJobs(), fetchSubcontractors()]);
        if (onRefreshWorkOrders) onRefreshWorkOrders();
      } else {
        alert(data.error || 'Failed to create work order');
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
      const res = await fetch(`/api/work-orders/${encodeURIComponent(woId)}`, {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        await Promise.all([fetchJobs(), fetchSubcontractors()]);
        if (onRefreshWorkOrders) onRefreshWorkOrders();
      } else {
        alert(data.error || 'Failed to delete work order');
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
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        await Promise.all([fetchJobs(), fetchSubcontractors()]);
        if (onRefreshWorkOrders) onRefreshWorkOrders();
      } else {
        alert(data.error || 'Failed to delete job');
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
      const res = await fetch(`/api/pm/subcontractors/${encodeURIComponent(subId)}`, {
        method: 'DELETE',
        headers
      });
      const data = await res.json();
      if (data.success) {
        await fetchSubcontractors();
      } else {
        alert(data.error || 'Failed to delete subcontractor');
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

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      for (const tradeGroup of job.extractedTrades) {
        // Find best sub match
        const lowerTrade = tradeGroup.tradeName.toLowerCase();
        const matchedSub = subcontractors.find(s => 
          (lowerTrade.includes('floor') && s.trade.toLowerCase().includes('floor')) ||
          (lowerTrade.includes('drywall') && s.trade.toLowerCase().includes('drywall')) ||
          (lowerTrade.includes('carpen') && s.trade.toLowerCase().includes('carpen')) ||
          (lowerTrade.includes('paint') && s.trade.toLowerCase().includes('paint')) ||
          (lowerTrade.includes('plumb') && s.trade.toLowerCase().includes('plumb'))
        ) || subcontractors[0];

        await fetch('/api/work-orders', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jobId: job.id,
            trade: tradeGroup.tradeName,
            unitArea: job.scopeSummary || 'Main Level',
            assignedSubId: matchedSub ? matchedSub.id : '',
            subName: matchedSub ? matchedSub.company : 'Trade Partner',
            subPhone: matchedSub ? matchedSub.phone : '',
            scheduledDate: new Date().toISOString().split('T')[0],
            tasks: tradeGroup.tasks
          })
        });
      }

      await Promise.all([fetchJobs(), fetchSubcontractors()]);
      if (onRefreshWorkOrders) onRefreshWorkOrders();
    } catch (err: any) {
      alert('Error generating trade work orders: ' + err.message);
    }
  };

  // Create new Subcontractor
  const handleCreateSub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubForm.name || !newSubForm.company || !newSubForm.email) return;

    setIsSubmittingSub(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'subcontractor',
          name: newSubForm.name,
          company: newSubForm.company,
          trade: newSubForm.trade,
          email: newSubForm.email,
          phone: newSubForm.phone,
          password: newSubForm.password
        })
      });

      const data = await res.json();
      if (data.success) {
        setShowAddSubModal(false);
        setNewSubForm({
          name: '',
          company: '',
          trade: 'Drywall, Finishing & Painting',
          email: '',
          phone: '',
          password: 'Password123!'
        });
        await fetchSubcontractors();
      } else {
        alert(data.error || 'Failed to register subcontractor');
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setIsSubmittingSub(false);
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
                            className="px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-[#C81D25] border border-red-200 text-xs font-bold transition"
                            title="Auto-create work orders for all extracted estimate trades"
                          >
                            + Auto-Create Trade WOs ({job.extractedTrades.length})
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
                                    wo.status === 'Completed'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : wo.status === 'In Progress'
                                        ? 'bg-amber-100 text-amber-800'
                                        : 'bg-slate-100 text-slate-700'
                                  }`}>
                                    {wo.status}
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
                        <span className="text-[10px] text-slate-500 font-medium">Photos Verified</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <button
                      onClick={() => onSwitchToSubView({
                        id: sub.id,
                        email: sub.email,
                        name: sub.name,
                        company: sub.company,
                        trade: sub.trade,
                        phone: sub.phone,
                        role: 'subcontractor',
                        assignedWoIds: sub.assignedWoIds || [],
                        permissions: ['view_assigned_work_orders', 'upload_inspection_photo', 'sign_off_work_order']
                      })}
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
                  sub: event.subName
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
                    {event.timestamp}
                  </div>
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
                  {subcontractors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.company} ({s.trade}) - {s.phone}
                    </option>
                  ))}
                </select>
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
                  placeholder="e.g. Apex Flooring Specialists"
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
                  placeholder="e.g. Dave Miller"
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
                    placeholder="(260) 555-0199"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Initial Subcontractor Password *
                </label>
                <input
                  type="text"
                  value={newSubForm.password}
                  onChange={(e) => setNewSubForm({ ...newSubForm, password: e.target.value })}
                  placeholder="Password123!"
                  required
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#C81D25]"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Share this password with the subcontractor so they can sign into the mobile field portal.
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
                {selectedPhoto.sub && (
                  <p className="text-[11px] text-slate-500">Submitted by {selectedPhoto.sub}</p>
                )}
              </div>
              <button
                onClick={() => setSelectedPhoto(null)}
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
          </div>
        </div>
      )}

    </div>
  );
};
