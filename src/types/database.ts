export type UserRole = "admin" | "staff" | "customer";

export type OrderStatus =
  | "Pending"
  | "Confirmed"
  | "Processing"
  | "Purchase Order Sent"
  | "Manufacturer Fulfilment Pending"
  | "Dispatched"
  | "Out for Delivery"
  | "Delivered"
  | "Cancelled";

export type PaymentStatus = "unpaid" | "partially_paid" | "paid";

export type PurchaseOrderStatus =
  | "Draft"
  | "Sent to Manufacturer"
  | "Acknowledged"
  | "In Production"
  | "Dispatched"
  | "Received"
  | "Cancelled";

export const ORDER_STATUS_FLOW: OrderStatus[] = [
  "Pending",
  "Confirmed",
  "Processing",
  "Purchase Order Sent",
  "Manufacturer Fulfilment Pending",
  "Dispatched",
  "Out for Delivery",
  "Delivered",
];

export const ALL_ORDER_STATUSES: OrderStatus[] = [...ORDER_STATUS_FLOW, "Cancelled"];

export const PO_STATUS_FLOW: PurchaseOrderStatus[] = [
  "Draft",
  "Sent to Manufacturer",
  "Acknowledged",
  "In Production",
  "Dispatched",
  "Received",
  "Cancelled",
];

export type PaymentMethod = "Bank Transfer" | "UPI" | "NEFT/RTGS" | "Cheque" | "Cash" | "Card";

export const PAYMENT_METHODS: PaymentMethod[] = [
  "Bank Transfer",
  "UPI",
  "NEFT/RTGS",
  "Cheque",
  "Cash",
  "Card",
];

export interface AppUser {
  id: string;
  role_id: string;
  role: UserRole;
  full_name: string;
  username: string | null;
  email: string;
  phone: string | null;
  is_active: boolean;
  created_at: string;
}

export interface AgencySettings {
  id: number;
  agency_name: string;
  legal_name: string;
  gstin: string;
  pan: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  logo_url: string | null;
  default_gst_rate: number;
  currency_symbol: string;
  order_prefix: string;
  po_prefix: string;
  invoice_prefix: string;
  bank_details: string | null;
  terms_and_conditions: string | null;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  description: string | null;
  parent_id: string | null;
  status: "active" | "inactive";
  sort_order: number;
  created_at: string;
}

export interface Manufacturer {
  id: string;
  company_name: string;
  logo_url: string | null;
  gallery_urls: string[];
  contact_person: string;
  phone: string;
  email: string | null;
  website: string | null;
  address: string;
  city: string | null;
  state: string | null;
  gst_number: string | null;
  description: string | null;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
  categories?: Category[];
}

export interface ProductPriceRecord {
  product_id: string;
  published_manufacturer_price: number;
  published_margin_source: "global" | "category" | "product" | "manual";
  published_margin_percentage: number;
  published_margin_amount: number;
  published_selling_price: number;
  published_at: string | null;
  draft_manufacturer_price: number;
  draft_margin_source: "global" | "category" | "product" | "manual";
  draft_margin_percentage: number;
  draft_margin_amount: number;
  draft_selling_price: number;
  approval_status: "published" | "pending_review";
  updated_at: string;
}

export interface InventoryRecord {
  product_id: string;
  available_quantity: number;
  reserved_quantity: number;
  sold_quantity: number;
  low_stock_threshold: number;
  updated_at: string;
}

export interface AdminProduct {
  id: string;
  manufacturer_id: string;
  category_id: string;
  name: string;
  sku: string;
  description: string | null;
  unit_of_measurement: string;
  min_order_quantity: number;
  hsn_code: string | null;
  gst_rate: number;
  is_published: boolean;
  is_featured: boolean;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
  manufacturer?: Pick<Manufacturer, "id" | "company_name" | "status">;
  category?: Pick<Category, "id" | "name" | "slug">;
  product_images?: { id: string; image_url: string; is_primary: boolean; sort_order: number }[];
  product_prices?: ProductPriceRecord | null;
  inventory?: InventoryRecord | null;
}

/**
 * Strictly customer-safe product shape.
 * Contains ZERO manufacturer, cost price, or margin properties.
 */
export interface CustomerCatalogProduct {
  id: string;
  category_id: string;
  category_name: string;
  category_slug: string;
  name: string;
  sku: string;
  description: string | null;
  unit_of_measurement: string;
  min_order_quantity: number;
  hsn_code: string | null;
  gst_rate: number;
  selling_price: number;
  has_custom_price: boolean;
  available_quantity: number;
  stock_status: "in_stock" | "low_stock" | "out_of_stock";
  primary_image_url: string | null;
  image_urls: string[];
  is_featured: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerProfile {
  id: string;
  user_id: string | null;
  business_name: string;
  owner_name: string;
  phone: string;
  email: string;
  business_address: string;
  city: string | null;
  state: string;
  pincode: string | null;
  gst_number: string | null;
  business_category: string | null;
  status: "pending" | "active" | "inactive" | "suspended";
  registered_at: string;
}

export interface CustomerAddress {
  id: string;
  customer_id: string;
  label: string;
  contact_name: string | null;
  contact_phone: string | null;
  address_line: string;
  city: string;
  state: string;
  pincode: string;
  is_default: boolean;
}

export interface OrderRecord {
  id: string;
  order_number: string;
  customer_id: string;
  delivery_address: {
    label?: string;
    contact_name?: string;
    contact_phone?: string;
    address_line: string;
    city: string;
    state: string;
    pincode: string;
  };
  notes: string | null;
  subtotal: number;
  tax_total: number;
  total_amount: number;
  paid_amount: number;
  due_amount: number;
  order_status: OrderStatus;
  payment_status: PaymentStatus;
  placed_at: string;
  updated_at: string;
  customers?: CustomerProfile;
}

export interface OrderItemRecord {
  id: string;
  order_id: string;
  product_id: string;
  product_name_snapshot: string;
  sku_snapshot: string;
  unit_snapshot: string;
  hsn_snapshot: string | null;
  quantity: number;
  unit_selling_price: number;
  gst_rate: number;
  tax_amount: number;
  line_total: number;
}

export interface InvoiceRecord {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  is_inter_state: boolean;
  subtotal: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  tax_total: number;
  total_amount: number;
  paid_amount: number;
  payment_status: PaymentStatus;
  notes: string | null;
  created_at: string;
  orders?: Pick<OrderRecord, "order_number" | "order_status">;
  customers?: CustomerProfile;
}

export interface OrderItemFinancialRecord {
  order_item_id: string;
  manufacturer_id: string;
  manufacturer_name_snapshot: string;
  unit_manufacturer_price: number;
  margin_percentage_snapshot: number;
  margin_amount_total: number;
  created_at: string;
}

export interface PurchaseOrderRecord {
  id: string;
  po_number: string;
  manufacturer_id: string;
  source_order_id: string | null;
  status: PurchaseOrderStatus;
  subtotal: number;
  tax_total: number;
  total_amount: number;
  expected_delivery_date: string | null;
  manufacturer_invoice_number: string | null;
  manufacturer_invoice_date: string | null;
  manufacturer_invoice_url: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  manufacturers?: Manufacturer;
  orders?: Pick<OrderRecord, "id" | "order_number" | "order_status">;
}

export interface PurchaseOrderItemRecord {
  id: string;
  purchase_order_id: string;
  order_item_id: string | null;
  product_id: string;
  product_name_snapshot: string;
  sku_snapshot: string;
  unit_snapshot: string;
  quantity: number;
  unit_manufacturer_price: number;
  gst_rate: number;
  tax_amount: number;
  line_total: number;
  created_at: string;
}

export interface PaymentRecord {
  id: string;
  invoice_id: string;
  customer_id: string;
  amount: number;
  payment_method: PaymentMethod;
  reference_number: string | null;
  payment_date: string;
  status: "recorded" | "voided";
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
}

export interface NotificationRecord {
  id: string;
  recipient_role: UserRole | null;
  recipient_user_id: string | null;
  title: string;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  created_at: string;
}

export interface InventoryMovementRecord {
  id: string;
  product_id: string;
  movement_type: "restock" | "manual_adjustment" | "order_reserved" | "order_released" | "order_sold";
  quantity_delta: number;
  balance_after: number;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  products?: Pick<AdminProduct, "id" | "name" | "sku" | "unit_of_measurement">;
  users?: Pick<AppUser, "full_name" | "email"> | null;
}

export interface AuditLogRecord {
  id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
  users?: Pick<AppUser, "full_name" | "email"> | null;
}

export interface CartItemRecord {
  id: string;
  customer_id: string;
  product_id: string;
  quantity: number;
  cart_status: "active" | "ordered";
  order_id: string | null;
  created_at: string;
  updated_at: string;
}
