import React, { useState, useEffect, useCallback } from 'react';
import { HeaderNav, AppTab } from './components/HeaderNav';
import { PMDashboard } from './components/PMDashboard';
import { SubcontractorPortal } from './components/SubcontractorPortal';
import { PMWorkOrderCreator } from './components/PMWorkOrderCreator';
import { AuthModal } from './components/AuthModal';
import { SubcontractorAuthPage } from './components/SubcontractorAuthPage';
import { WorkOrder, LineItem, VerificationResponse, User } from './types';
import { ShieldCheck, Sparkles } from 'lucide-react';
import { OfflineIndicator } from './components/OfflineIndicator';
import { safeFetchJson } from './utils/api';

export default function App() {
  const [currentTab, setCurrentTab] = useState<AppTab>('pm_hub');
  const [isMobileDeviceFrame, setIsMobileDeviceFrame] = useState(false);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [selectedWoId, setSelectedWoId] = useState<string>('');
  const [currentWorkOrder, setCurrentWorkOrder] = useState<WorkOrder | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [isLoadingWo, setIsLoadingWo] = useState(false);
  const [verifyingLineId, setVerifyingLineId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'warning' | 'error' } | null>(null);

  // User Authentication & RBAC state
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(() => {
    return localStorage.getItem('fieldproof_auth_token') || null;
  });
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [accessDeniedError, setAccessDeniedError] = useState<string | null>(null);

  // Preselection for Work Order Creator
  const [creatorPreselectedSub, setCreatorPreselectedSub] = useState<{
    id: string;
    company: string;
    phone?: string;
  } | null>(null);

  const showToast = (text: string, type: 'success' | 'warning' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  const loadWorkOrderDetails = useCallback(async (woId: string, token: string | null = authToken) => {
    setIsLoadingWo(true);
    setAccessDeniedError(null);
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const { ok, status, data, error } = await safeFetchJson<any>(`/api/work-orders/${encodeURIComponent(woId)}`, { headers });
      
      if (status === 403 || !ok || !data?.success) {
        if (status === 403) {
          setAccessDeniedError(data?.error || 'Access Denied: You do not have permission to view this work order.');
          setCurrentWorkOrder(null);
          setLineItems([]);
        } else {
          showToast(error || data?.error || 'Work Order not found', 'error');
        }
      } else {
        setAccessDeniedError(null);
        setCurrentWorkOrder(data.workOrder);
        setLineItems(data.lineItems);
      }
    } catch (err: any) {
      showToast('Error loading work order: ' + err.message, 'error');
    } finally {
      setIsLoadingWo(false);
    }
  }, [authToken]);

  const loadWorkOrdersList = useCallback(async (token: string | null = authToken, targetWoId?: string) => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const { ok, data } = await safeFetchJson<any>('/api/work-orders', { headers });
      if (ok && data?.success && data.workOrders) {
        setWorkOrders(data.workOrders);
        
        let activeId = targetWoId || selectedWoId;
        const isTargetAllowed = data.workOrders.some((w: WorkOrder) => w.woId === activeId);
        if (!isTargetAllowed && data.workOrders.length > 0) {
          activeId = data.workOrders[0].woId;
        }

        if (activeId) {
          setSelectedWoId(activeId);
          loadWorkOrderDetails(activeId, token);
        }
      }
    } catch (err) {
      console.error('Failed to load work orders list:', err);
    }
  }, [authToken, selectedWoId, loadWorkOrderDetails]);

  // Initial Auth & System Initialization
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const woIdParam = urlParams.get('woId');
    const initialWo = woIdParam ? woIdParam.toUpperCase() : '';
    if (woIdParam) {
      setSelectedWoId(initialWo);
      setCurrentTab('subcontractor');
    }

    // Health check
    safeFetchJson('/api/health').catch(() => {});

    const initAuth = async () => {
      let token = authToken;

      if (token) {
        const { ok, data } = await safeFetchJson<any>('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (ok && data?.success && data.user) {
          setCurrentUser(data.user);
          if (data.user.role === 'subcontractor') {
            setCurrentTab('subcontractor');
          } else {
            setCurrentTab('pm_hub');
          }
          loadWorkOrdersList(token, initialWo);
        } else {
          setCurrentUser(null);
          setAuthToken(null);
          localStorage.removeItem('fieldproof_auth_token');
        }
      }
    };

    initAuth();
  }, []);

  const handleSelectWorkOrder = (woId: string) => {
    setSelectedWoId(woId);
    loadWorkOrderDetails(woId, authToken);
  };

  const handleLoginSuccess = (user: User, token: string) => {
    setCurrentUser(user);
    setAuthToken(token);
    localStorage.setItem('fieldproof_auth_token', token);
    showToast(
      `Signed in as ${user.name} (${user.role === 'pm' ? 'Project Manager' : 'Subcontractor'})`,
      'success'
    );

    if (user.role === 'subcontractor') {
      setCurrentTab('subcontractor');
      const targetWo = user.assignedWoIds?.[0] || '';
      if (targetWo) {
        setSelectedWoId(targetWo);
      }
      loadWorkOrdersList(token, targetWo);
    } else {
      setCurrentTab('pm_hub');
      loadWorkOrdersList(token);
    }
  };

  const handleLogout = async () => {
    if (authToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
      } catch (err) {
        console.error('Logout error:', err);
      }
    }
    setCurrentUser(null);
    setAuthToken(null);
    localStorage.removeItem('fieldproof_auth_token');
    showToast('Signed out of FieldProof.', 'warning');
    setIsAuthModalOpen(false);
  };

  // Photo uploaded by subcontractor
  const handlePhotoUploaded = async (
    lineId: string,
    base64: string,
    mimeType: string,
    taskDescription: string
  ) => {
    setVerifyingLineId(lineId);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const { ok, status, data } = await safeFetchJson<VerificationResponse>('/api/verify-photo', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          lineId,
          woId: selectedWoId,
          base64Image: base64,
          mimeType,
          taskDescription
        })
      });

      if (status === 403) {
        showToast(data?.error || 'Access Denied: You cannot upload photos for unassigned work orders.', 'error');
        setAccessDeniedError(data?.error || 'Access Denied');
        return;
      }

      const res = data;
      if (ok && res?.success) {
        // Update local line items state
        setLineItems(prev => prev.map(item => {
          if (item.lineId === lineId) {
            return {
              ...item,
              status: res.status,
              notes: res.notes,
              photoUrl: base64,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
          }
          return item;
        }));

        // Update Work Order progress stats
        if (currentWorkOrder) {
          const updatedWo = {
            ...currentWorkOrder,
            completedItems: res.completedCount,
            totalItems: res.totalCount,
            status: res.isComplete ? ('Completed' as const) : (res.completedCount > 0 ? ('In Progress' as const) : ('Open' as const))
          };
          setCurrentWorkOrder(updatedWo);
          setWorkOrders(prev => prev.map(w => w.woId === updatedWo.woId ? updatedWo : w));
        }

        showToast('Inspection photo submitted successfully!', 'success');
      } else {
        showToast(res?.error || 'Verification failed', 'error');
      }
    } catch (err: any) {
      showToast('Network error during photo upload: ' + err.message, 'error');
    } finally {
      setVerifyingLineId(null);
    }
  };

  // Sign off completed work order
  const handleSignOff = async (signerName: string) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const { ok, status, data } = await safeFetchJson<any>(`/api/work-orders/${encodeURIComponent(selectedWoId)}/sign-off`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ signatureName: signerName })
      });

      if (status === 403) {
        showToast(data?.error || 'Access Denied', 'error');
        return;
      }

      if (ok && data?.success) {
        setCurrentWorkOrder(data.workOrder);
        setWorkOrders(prev => prev.map(w => w.woId === data.workOrder.woId ? data.workOrder : w));
        showToast(`Work order signed off by ${signerName}! Stored in Sheets.`, 'success');
      } else {
        showToast(data?.error || 'Sign off failed', 'error');
      }
    } catch (err: any) {
      showToast('Sign-off error: ' + err.message, 'error');
    }
  };

  // Called when PM creates a new work order
  const handleWorkOrderCreated = async (newWo: WorkOrder) => {
    setWorkOrders(prev => [newWo, ...prev]);
    setSelectedWoId(newWo.woId);
    setCurrentWorkOrder(newWo);
    await loadWorkOrdersList(authToken, newWo.woId);
  };

  // Switch to subcontractor view for a specific work order
  const handleOpenSubcontractorView = (woId: string) => {
    setSelectedWoId(woId);
    loadWorkOrderDetails(woId, authToken);
    setCurrentTab('subcontractor');
  };

  // Open Work Order Creator with a preselected subcontractor
  const handleOpenCreateWorkOrderForSub = (subId: string, subCompany: string, subPhone?: string) => {
    setCreatorPreselectedSub({ id: subId, company: subCompany, phone: subPhone });
    setCurrentTab('pm_creator');
  };

  // Switch into that subcontractor's account/preview
  const handleSwitchToSubView = (subUser: User, woId?: string) => {
    setCurrentUser(subUser);
    if (woId) {
      setSelectedWoId(woId);
      loadWorkOrderDetails(woId, authToken);
    }
    setCurrentTab('subcontractor');
    showToast(`Viewing Subcontractor Portal as ${subUser.name} (${subUser.company})`, 'success');
  };

  // Start with an account login / create account page for subcontractors
  if (!currentUser) {
    return (
      <SubcontractorAuthPage
        onLoginSuccess={handleLoginSuccess}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col selection:bg-[#C81D25] selection:text-white">
      
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 max-w-sm w-11/12 animate-in fade-in slide-in-from-top-4">
          <div className={`px-4 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border text-xs font-bold ${
            toastMessage.type === 'success'
              ? 'bg-slate-950 text-white border-[#C81D25] shadow-red-950/30'
              : (toastMessage.type === 'warning'
                ? 'bg-slate-950 text-amber-400 border-amber-500/40'
                : 'bg-slate-950 text-red-400 border-red-500/40')
          }`}>
            <span className="text-base">
              {toastMessage.type === 'success' ? '🎯' : (toastMessage.type === 'warning' ? '⚠️' : '❌')}
            </span>
            <span className="flex-1 text-white leading-snug">{toastMessage.text}</span>
          </div>
        </div>
      )}

      {/* Global Navigation Header */}
      <HeaderNav
        currentTab={currentTab}
        setTab={setCurrentTab}
        isMobileDeviceFrame={isMobileDeviceFrame}
        setIsMobileDeviceFrame={setIsMobileDeviceFrame}
        workOrders={workOrders}
        selectedWoId={selectedWoId}
        onSelectWo={handleSelectWorkOrder}
        currentUser={currentUser}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
        onLogout={handleLogout}
      />

      {/* Main Content Area */}
      <main className="flex-1">
        
        {/* VIEW 1: PM COMMAND HUB (PM PRIMARY DASHBOARD) */}
        {currentTab === 'pm_hub' && (
          <PMDashboard
            currentUser={currentUser}
            authToken={authToken}
            workOrders={workOrders}
            onOpenCreateWorkOrderForSub={handleOpenCreateWorkOrderForSub}
            onSwitchToSubView={handleSwitchToSubView}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onSelectWorkOrderForInspection={(woId) => {
              setSelectedWoId(woId);
              loadWorkOrderDetails(woId, authToken);
              setCurrentTab('subcontractor');
            }}
            onNavigateToUploadEstimate={() => setCurrentTab('pm_creator')}
            onRefreshWorkOrders={() => loadWorkOrdersList(authToken)}
          />
        )}

        {/* VIEW 2: SUBCONTRACTOR FIELD PORTAL */}
        {currentTab === 'subcontractor' && (
          <SubcontractorPortal
            currentUser={currentUser}
            workOrders={workOrders}
            selectedWo={currentWorkOrder}
            lineItems={lineItems}
            onSelectWo={handleSelectWorkOrder}
            onPhotoUploaded={handlePhotoUploaded}
            onSignOff={handleSignOff}
            isLoadingWo={isLoadingWo}
            verifyingLineId={verifyingLineId}
            accessDeniedError={accessDeniedError}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onLogout={handleLogout}
            isMobileDeviceFrame={isMobileDeviceFrame}
          />
        )}

        {/* VIEW 3: PM WORK ORDER DISPATCH / CREATOR */}
        {currentTab === 'pm_creator' && (
          <PMWorkOrderCreator
            onWorkOrderCreated={handleWorkOrderCreated}
            onOpenSubcontractorView={handleOpenSubcontractorView}
            currentUser={currentUser}
            authToken={authToken}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onNavigateToJobsDashboard={() => {
              setCurrentTab('pm_hub');
              loadWorkOrdersList(authToken);
            }}
            preselectedSubId={creatorPreselectedSub?.id}
            preselectedSubName={creatorPreselectedSub?.company}
            preselectedSubPhone={creatorPreselectedSub?.phone}
          />
        )}

      </main>

      {/* Authentication & Profile Switcher Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        currentUser={currentUser}
        onLoginSuccess={handleLoginSuccess}
        onLogout={handleLogout}
      />

      {/* Footer - Hays + Sons (Hidden on mobile to preserve screen space for bottom nav) */}
      <footer className="hidden md:block bg-slate-950 text-slate-400 text-xs py-5 px-4 border-t-2 border-[#C81D25] text-center">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="font-extrabold text-white">Hays + Sons</span>
            <span className="text-[#C81D25]">•</span>
            <span className="font-medium text-slate-300">We Do Restoration Right</span>
            <span className="text-slate-600 hidden md:inline">|</span>
            <span className="text-[11px] text-slate-500 hidden md:inline">909 Production Rd., Fort Wayne, IN 46808</span>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <a href="https://haysandsons.com" target="_blank" rel="noreferrer" className="text-slate-300 hover:text-white font-bold transition">
              haysandsons.com
            </a>
            <span>•</span>
            <span>Subcontractor Portal & PM Command</span>
            <span>•</span>
            <span>Field Photo Verification</span>
          </div>
        </div>
      </footer>

      {/* PWA Offline Connection Indicator */}
      <OfflineIndicator />

    </div>
  );
}
