export type UserRole = 'pm' | 'subcontractor';

export type UserPermission = 
  | 'create_work_order'
  | 'view_all_work_orders'
  | 'edit_work_order'
  | 'delete_work_order'
  | 'view_assigned_work_orders'
  | 'upload_inspection_photo'
  | 'sign_off_work_order'
  | 'view_analytics';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  company: string;
  trade?: string;
  phone?: string;
  assignedWoIds: string[];
  permissions: UserPermission[];
  token?: string;
  createdAt?: string;
  tempPassword?: string;
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  type: 'photo_uploaded' | 'ai_verified' | 'wo_created' | 'wo_completed' | 'sub_created' | 'sub_signed_off';
  subId?: string;
  subName: string;
  company: string;
  woId?: string;
  projectName?: string;
  lineId?: string;
  taskDescription?: string;
  verdict?: 'PASS' | 'RETAKE_NEEDED' | '';
  notes?: string;
  photoUrl?: string;
}

export interface SubcontractorSummary {
  id: string;
  name: string;
  email: string;
  company: string;
  trade: string;
  phone: string;
  assignedWoIds: string[];
  totalJobs: number;
  completedJobs: number;
  totalItems: number;
  completedItems: number;
  lastActive?: string;
  tempPassword?: string;
}

export interface AuthResponse {
  success: boolean;
  user?: User;
  token?: string;
  error?: string;
}

export interface Job {
  id: string;
  customerName: string;
  propertyAddress: string;
  phone?: string;
  email?: string;
  claimNumber?: string;
  lossType?: string;
  totalEstimate?: string;
  scopeSummary?: string;
  notes?: string;
  extractedTrades?: ExtractedJobTradeGroup[];
  extractedTasks?: string[];
  createdAt: string;
  workOrderIds: string[];
  workOrders?: WorkOrder[];
}

export interface LineItem {
  lineId: string;
  woId: string;
  taskDescription: string;
  status: 'Pending' | 'Completed' | 'Flagged';
  photoUrl: string;
  notes?: string;
  timestamp: string;
}

export interface WorkOrder {
  woId: string;
  jobId?: string;
  projectName: string;
  customerName?: string;
  propertyAddress?: string;
  trade?: string;
  unitArea: string;
  subName: string;
  subPhone: string;
  assignedSubId?: string;
  scheduledDate: string;
  status: 'Open' | 'In Progress' | 'Completed';
  totalItems: number;
  completedItems: number;
  signedBy?: string;
  signedAt?: string;
  createdBy?: string;
}

export interface VerificationResponse {
  success: boolean;
  lineId: string;
  status: 'Completed' | 'Flagged';
  notes?: string;
  photoUrl?: string;
  completedCount: number;
  totalCount: number;
  isComplete: boolean;
  error?: string;
}

export interface ExtractedJobTradeGroup {
  tradeName: string;
  tasks: string[];
}

export interface ExtractedJobRoomGroup {
  roomName: string;
  tasks: string[];
}

export interface ExtractedJobData {
  projectName: string;
  propertyAddress?: string;
  insuredName?: string;
  claimNumber?: string;
  lossType?: string;
  unitArea: string;
  suggestedTrade: string;
  tasks: string[];
  tradeBreakdown?: ExtractedJobTradeGroup[];
  roomBreakdown?: ExtractedJobRoomGroup[];
  totalEstimate?: string;
  notes?: string;
  rawTextPreview?: string;
}
