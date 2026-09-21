import React, { useEffect, useState } from 'react';
import { ClipboardPlus, HardHat, Plus, Send, X } from 'lucide-react';
import { Job, User, WorkOrder } from '../types';
import { safeFetchJson } from '../utils/api';

interface PMManualWorkOrderPageProps {
  currentUser: User | null;
  authToken: string | null;
  onWorkOrderCreated: (workOrder: WorkOrder) => Promise<void>;
  onNavigateToJobs: () => void;
}

interface SubcontractorOption {
  id: string;
  company: string;
  trade: string;
  phone: string;
}

const defaultTasks = [
  'Document pre-existing conditions before starting work',
  'Complete the assigned trade scope',
  'Clean the work area and photograph the completed result'
].join('\n');

export const PMManualWorkOrderPage: React.FC<PMManualWorkOrderPageProps> = ({
  currentUser,
  authToken,
  onWorkOrderCreated,
  onNavigateToJobs
}) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [subcontractors, setSubcontractors] = useState<SubcontractorOption[]>([]);
  const [useNewJob, setUseNewJob] = useState(false);
  const [jobId, setJobId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  const [trade, setTrade] = useState('');
  const [unitArea, setUnitArea] = useState('');
  const [assignedSubId, setAssignedSubId] = useState('');
  const [scheduledDate, setScheduledDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [tasksText, setTasksText] = useState(defaultTasks);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const headers: Record<string, string> = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    Promise.all([
      safeFetchJson<any>('/api/jobs', { headers }),
      safeFetchJson<any>('/api/subcontractors', { headers })
    ]).then(([jobsResult, subsResult]) => {
      if (jobsResult.ok && Array.isArray(jobsResult.data?.jobs)) {
        setJobs(jobsResult.data.jobs);
        if (jobsResult.data.jobs[0]) setJobId(jobsResult.data.jobs[0].id);
      }
      if (subsResult.ok && Array.isArray(subsResult.data?.subcontractors)) {
        setSubcontractors(subsResult.data.subcontractors);
        if (subsResult.data.subcontractors[0]) setAssignedSubId(subsResult.data.subcontractors[0].id);
      }
    });
  }, [authToken]);

  const resetForm = (preserveMessage = false) => {
    setUseNewJob(false);
    setCustomerName('');
    setPropertyAddress('');
    setTrade('');
    setUnitArea('');
    setTasksText(defaultTasks);
    if (!preserveMessage) setMessage(null);
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (currentUser?.role !== 'pm') {
      setError('Only Project Managers can create work orders.');
      return;
    }

    const tasks = tasksText.split('\n').map(task => task.trim()).filter(Boolean);
    const selectedSub = subcontractors.find(sub => sub.id === assignedSubId);
    if (!trade.trim() || !unitArea.trim() || !selectedSub || tasks.length === 0) {
      setError('Choose a subcontractor and provide a trade, work area, and at least one punch-list task.');
      return;
    }
    if (useNewJob && (!customerName.trim() || !propertyAddress.trim())) {
      setError('Customer name and property address are required for a new job.');
      return;
    }
    if (!useNewJob && !jobId) {
      setError('Choose an existing job or create a new job first.');
      return;
    }

    setIsSaving(true);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    try {
      let effectiveJobId = jobId;
      let selectedJob = jobs.find(job => job.id === jobId);

      if (useNewJob) {
        const jobResult = await safeFetchJson<any>('/api/jobs', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            customerName: customerName.trim(),
            propertyAddress: propertyAddress.trim(),
            lossType: 'Restoration',
            notes: `Created with manual ${trade.trim()} work order.`
          })
        });
        if (!jobResult.ok || !jobResult.data?.job) {
          throw new Error(jobResult.error || jobResult.data?.error || 'Could not create the job.');
        }
        effectiveJobId = jobResult.data.job.id;
        selectedJob = jobResult.data.job;
        setJobs(previous => [jobResult.data.job, ...previous]);
      }

      const workOrderResult = await safeFetchJson<any>('/api/work-orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jobId: effectiveJobId,
          projectName: selectedJob ? `${selectedJob.customerName} - ${trade.trim()}` : trade.trim(),
          trade: trade.trim(),
          unitArea: unitArea.trim(),
          assignedSubId: selectedSub.id,
          subName: selectedSub.company,
          subPhone: selectedSub.phone,
          scheduledDate,
          tasks
        })
      });
      if (!workOrderResult.ok || !workOrderResult.data?.workOrder) {
        throw new Error(workOrderResult.error || workOrderResult.data?.error || 'Could not create the work order.');
      }

      await onWorkOrderCreated(workOrderResult.data.workOrder);
      setMessage(`Work order ${workOrderResult.data.workOrder.woId} assigned to ${selectedSub.company}.`);
      resetForm(true);
    } catch (requestError: any) {
      setError(requestError.message || 'Could not create the work order.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-black text-slate-900 flex items-center gap-2"><ClipboardPlus className="w-5 h-5 text-[#C81D25]" /> Manual Work Order</h1>
          <p className="text-xs text-slate-500 mt-1">Create a job if needed, assign a subcontractor, and enter one punch-list task per line.</p>
        </div>
        <button type="button" onClick={onNavigateToJobs} className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold">View Jobs & Orders</button>
      </div>

      {message && <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">{message}</div>}
      {error && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs font-semibold">{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5 sm:p-6 space-y-5">
        <section className="space-y-3">
          <div className="flex items-center justify-between"><h2 className="font-black text-sm text-slate-900">1. Link to a job</h2><button type="button" onClick={() => setUseNewJob(value => !value)} className="text-xs font-bold text-[#C81D25] hover:text-[#A8151D]">{useNewJob ? 'Choose existing job' : '+ Create new job'}</button></div>
          {useNewJob ? (
            <div className="grid sm:grid-cols-2 gap-3">
              <input required value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Customer / job name" className="field" />
              <input required value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} placeholder="Property address" className="field" />
            </div>
          ) : (
            <select required value={jobId} onChange={e => setJobId(e.target.value)} className="field">
              <option value="">Select a job</option>
              {jobs.map(job => <option key={job.id} value={job.id}>{job.id} — {job.customerName} · {job.propertyAddress}</option>)}
            </select>
          )}
        </section>

        <section className="space-y-3 pt-4 border-t border-slate-100">
          <h2 className="font-black text-sm text-slate-900">2. Assign the work</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <input required value={trade} onChange={e => setTrade(e.target.value)} placeholder="Trade / scope (e.g. Drywall)" className="field" />
            <input required value={unitArea} onChange={e => setUnitArea(e.target.value)} placeholder="Work area / room" className="field" />
            <select required value={assignedSubId} onChange={e => setAssignedSubId(e.target.value)} className="field">
              <option value="">Assign subcontractor</option>
              {subcontractors.map(sub => <option key={sub.id} value={sub.id}>{sub.company} — {sub.trade}</option>)}
            </select>
            <input required type="date" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} className="field" />
          </div>
        </section>

        <section className="space-y-2 pt-4 border-t border-slate-100">
          <label className="font-black text-sm text-slate-900">3. Punch-list tasks</label>
          <p className="text-xs text-slate-500">Each line becomes a separate task for the subcontractor to complete and photograph.</p>
          <textarea required value={tasksText} onChange={e => setTasksText(e.target.value)} rows={7} className="field resize-y leading-relaxed" />
        </section>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
          <button type="button" onClick={resetForm} className="p-2 rounded-xl text-slate-400 hover:text-slate-700" title="Clear form"><X className="w-4 h-4" /></button>
          <button disabled={isSaving} className="px-4 py-2.5 rounded-xl bg-[#C81D25] hover:bg-[#A8151D] text-white text-xs font-black shadow-sm disabled:opacity-50 flex items-center gap-2"><Send className="w-4 h-4" />{isSaving ? 'Creating…' : 'Create & Assign Work Order'}</button>
        </div>
      </form>
      <style>{`.field { width: 100%; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.625rem 0.75rem; font-size: 0.75rem; color: #0f172a; outline: none; } .field:focus { box-shadow: 0 0 0 2px #fecaca; border-color: #C81D25; }`}</style>
    </div>
  );
};
