import { fetchAllRows, supabase } from "@/lib/supabase";
import {
  generateAdminOrderDetailPdf,
  generateAllCustomersPdf,
  generateAllManufacturersPdf,
  generateAllOrdersDetailsPdf,
  generateCustomerDetailPdf,
  generateManufacturerDetailPdf,
  generateMasterBusinessDataPdf,
  type AllCustomersPdfData,
  type AllManufacturersPdfData,
  type AllOrdersPdfData,
  type ManufacturerWithCategories,
  type PdfCustomerAddressRow,
  type PdfCustomerCustomPriceRow,
  type PdfCustomerFinancialStats,
  type PdfDetailedOrderEntry,
  type PdfDetailedOrderItem,
} from "@/lib/pdfGenerator";
import type {
  AdminProduct,
  AgencySettings,
  Category,
  CustomerAddress,
  CustomerProfile,
  InvoiceRecord,
  Manufacturer,
  OrderItemFinancialRecord,
  OrderItemRecord,
  OrderRecord,
  PaymentRecord,
  PurchaseOrderRecord,
} from "@/types/database";

const FALLBACK_AGENCY: AgencySettings = {
  id: 1,
  agency_name: "TradeBridge B2B Supply Agency",
  legal_name: "TradeBridge Distribution Pvt. Ltd.",
  gstin: "",
  pan: "",
  address: "",
  city: "",
  state: "Telangana",
  pincode: "",
  phone: "",
  email: "",
  logo_url: null,
  default_gst_rate: 18,
  currency_symbol: "₹",
  order_prefix: "ORD",
  po_prefix: "PO",
  invoice_prefix: "INV",
  bank_details: null,
  terms_and_conditions: null,
};

export async function fetchAgencySettingsForPdf(): Promise<AgencySettings> {
  const { data, error } = await supabase.from("agency_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message || "Failed to load agency settings");
  return (data as AgencySettings | null) ?? FALLBACK_AGENCY;
}

interface RawCustomPriceRow {
  id: string;
  customer_id: string;
  product_id: string;
  custom_selling_price: number;
  is_active: boolean;
  products:
    | {
        name: string;
        sku: string;
        product_prices:
          | {
              published_selling_price: number;
              published_manufacturer_price: number | null;
              draft_manufacturer_price: number | null;
            }
          | {
              published_selling_price: number;
              published_manufacturer_price: number | null;
              draft_manufacturer_price: number | null;
            }[]
          | null;
      }
    | null;
}

interface RawManufacturerRow extends Manufacturer {
  manufacturer_categories?: { category_id: string; categories: Pick<Category, "id" | "name"> | null }[];
}

type RawOrderWithCustomer = Omit<OrderRecord, "customers"> & {
  customers: CustomerProfile | null;
};

interface RawDetailedOrderItem extends OrderItemRecord {
  order_item_financials: OrderItemFinancialRecord | OrderItemFinancialRecord[] | null;
  purchase_order_items:
    | {
        id: string;
        purchase_order_id: string;
        purchase_orders: { id: string; po_number: string; status: string } | null;
      }[]
    | null;
}

function firstOrObj<T>(val: T | T[] | null | undefined): T | null {
  if (!val) return null;
  return Array.isArray(val) ? (val[0] ?? null) : val;
}

function mapCustomPriceRow(
  cp: RawCustomPriceRow,
  customerNameMap: Map<string, string>
): PdfCustomerCustomPriceRow {
  const prod = cp.products;
  const pp = firstOrObj(prod?.product_prices);
  const mfgCost = Number(pp?.published_manufacturer_price ?? pp?.draft_manufacturer_price ?? 0);
  return {
    id: cp.id,
    customer_id: cp.customer_id,
    customer_business_name: customerNameMap.get(cp.customer_id) || "Customer",
    product_id: cp.product_id,
    product_name: prod?.name || "Product",
    sku: prod?.sku || "-",
    mfg_cost: mfgCost,
    standard_selling_price: Number(pp?.published_selling_price ?? 0),
    custom_selling_price: Number(cp.custom_selling_price ?? 0),
    is_active: Boolean(cp.is_active),
  };
}

export async function fetchAllCustomersPdfData(): Promise<AllCustomersPdfData> {
  const [customers, rawAddresses, rawCustomPrices, orders] = await Promise.all([
    fetchAllRows<CustomerProfile>((from, to) =>
      supabase.from("customers").select("*").order("business_name").order("id").range(from, to)
    ),
    fetchAllRows<CustomerAddress>((from, to) =>
      supabase
        .from("customer_addresses")
        .select("*")
        .order("customer_id")
        .order("is_default", { ascending: false })
        .order("created_at")
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<RawCustomPriceRow>((from, to) =>
      supabase
        .from("customer_product_prices")
        .select(
          "id, customer_id, product_id, custom_selling_price, is_active, products(name, sku, product_prices(published_selling_price, published_manufacturer_price, draft_manufacturer_price))"
        )
        .order("customer_id")
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<Pick<OrderRecord, "id" | "customer_id" | "total_amount" | "paid_amount" | "due_amount" | "order_status">>(
      (from, to) =>
        supabase
          .from("orders")
          .select("id, customer_id, total_amount, paid_amount, due_amount, order_status")
          .order("id")
          .range(from, to)
    ),
  ]);

  const customerNameMap = new Map(customers.map((c) => [c.id, c.business_name]));

  const addresses: PdfCustomerAddressRow[] = rawAddresses.map((addr) => ({
    ...addr,
    customer_business_name: customerNameMap.get(addr.customer_id) || "Customer",
  }));

  const customPrices: PdfCustomerCustomPriceRow[] = rawCustomPrices.map((cp) => mapCustomPriceRow(cp, customerNameMap));

  const statsByCustomerId = new Map<string, PdfCustomerFinancialStats>();
  const ensureStats = (customerId: string): PdfCustomerFinancialStats => {
    const existing = statsByCustomerId.get(customerId);
    if (existing) return existing;
    const init: PdfCustomerFinancialStats = {
      activeOrderCount: 0,
      cancelledOrderCount: 0,
      totalOrdered: 0,
      totalPaid: 0,
      totalDue: 0,
      savedAddressCount: 0,
      customPriceCount: 0,
    };
    statsByCustomerId.set(customerId, init);
    return init;
  };

  customers.forEach((c) => ensureStats(c.id));

  addresses.forEach((a) => {
    ensureStats(a.customer_id).savedAddressCount += 1;
  });

  customPrices.forEach((cp) => {
    ensureStats(cp.customer_id).customPriceCount += 1;
  });

  orders.forEach((o) => {
    const st = ensureStats(o.customer_id);
    if (o.order_status === "Cancelled") {
      st.cancelledOrderCount += 1;
      return;
    }
    const total = Number(o.total_amount ?? 0);
    const paid = Number(o.paid_amount ?? 0);
    const due = Math.max(0, Number(o.due_amount ?? total - paid));
    st.activeOrderCount += 1;
    st.totalOrdered += total;
    st.totalPaid += paid;
    st.totalDue += due;
  });

  return {
    customers,
    addresses,
    customPrices,
    statsByCustomerId,
  };
}

export async function fetchAllManufacturersPdfData(): Promise<AllManufacturersPdfData> {
  const [rawManufacturers, products, purchaseOrders] = await Promise.all([
    fetchAllRows<RawManufacturerRow>((from, to) =>
      supabase
        .from("manufacturers")
        .select("*, manufacturer_categories(category_id, categories(id, name))")
        .order("company_name")
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<AdminProduct>((from, to) =>
      supabase
        .from("products")
        .select("*, manufacturer:manufacturers(id, company_name, status), category:categories(id, name, slug), product_prices(*), inventory(*)")
        .order("name")
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<PurchaseOrderRecord>((from, to) =>
      supabase
        .from("purchase_orders")
        .select("*, manufacturers(id, company_name), orders(id, order_number, order_status)")
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    ),
  ]);

  const manufacturers: ManufacturerWithCategories[] = rawManufacturers.map((m) => ({
    ...m,
    categories: (m.manufacturer_categories ?? [])
      .map((mc) => mc.categories)
      .filter((c): c is Pick<Category, "id" | "name"> => Boolean(c)),
  }));

  return {
    manufacturers,
    products,
    purchaseOrders,
  };
}

export async function fetchAllOrdersPdfData(): Promise<AllOrdersPdfData> {
  const [orders, rawItems, invoices, payments, purchaseOrders] = await Promise.all([
    fetchAllRows<RawOrderWithCustomer>((from, to) =>
      supabase.from("orders").select("*, customers(*)").order("placed_at", { ascending: false }).order("id").range(from, to)
    ),
    fetchAllRows<RawDetailedOrderItem>((from, to) =>
      supabase
        .from("order_items")
        .select(
          "*, order_item_financials(*), purchase_order_items(id, purchase_order_id, purchase_orders(id, po_number, status))"
        )
        .order("order_id")
        .order("created_at")
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<InvoiceRecord>((from, to) =>
      supabase.from("invoices").select("*").order("invoice_date", { ascending: false }).order("id").range(from, to)
    ),
    fetchAllRows<PaymentRecord>((from, to) =>
      supabase
        .from("payments")
        .select("*")
        .order("payment_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<PurchaseOrderRecord>((from, to) =>
      supabase
        .from("purchase_orders")
        .select("*, manufacturers(id, company_name)")
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    ),
  ]);

  const itemsByOrderId = new Map<string, PdfDetailedOrderItem[]>();
  rawItems.forEach((raw) => {
    const fin = firstOrObj(raw.order_item_financials);
    const linkedPoNumbers = (raw.purchase_order_items ?? [])
      .map((poi) => poi.purchase_orders)
      .filter((po): po is { id: string; po_number: string; status: string } => Boolean(po && po.status !== "Cancelled"))
      .map((po) => po.po_number);

    const mapped: PdfDetailedOrderItem = {
      ...raw,
      financial: fin,
      linkedPoNumbers: Array.from(new Set(linkedPoNumbers)),
    };

    const list = itemsByOrderId.get(raw.order_id) ?? [];
    list.push(mapped);
    itemsByOrderId.set(raw.order_id, list);
  });

  const invoiceByOrderId = new Map<string, InvoiceRecord>();
  const orderIdByInvoiceId = new Map<string, string>();
  invoices.forEach((inv) => {
    invoiceByOrderId.set(inv.order_id, inv);
    orderIdByInvoiceId.set(inv.id, inv.order_id);
  });

  const paymentsByOrderId = new Map<string, PaymentRecord[]>();
  payments.forEach((p) => {
    const oid = orderIdByInvoiceId.get(p.invoice_id);
    if (!oid) return;
    const list = paymentsByOrderId.get(oid) ?? [];
    list.push(p);
    paymentsByOrderId.set(oid, list);
  });

  const posByOrderId = new Map<string, PurchaseOrderRecord[]>();
  purchaseOrders.forEach((po) => {
    if (!po.source_order_id) return;
    const list = posByOrderId.get(po.source_order_id) ?? [];
    list.push(po);
    posByOrderId.set(po.source_order_id, list);
  });

  const entries: PdfDetailedOrderEntry[] = orders.map((order) => {
    const items = itemsByOrderId.get(order.id) ?? [];
    let mfgCostTotal = 0;
    let grossMarginTotal = 0;
    items.forEach((item) => {
      if (item.financial) {
        mfgCostTotal += Number(item.financial.unit_manufacturer_price ?? 0) * Number(item.quantity ?? 0);
        grossMarginTotal += Number(item.financial.margin_amount_total ?? 0);
      }
    });

    return {
      order,
      items,
      invoice: invoiceByOrderId.get(order.id) ?? null,
      payments: paymentsByOrderId.get(order.id) ?? [],
      purchaseOrders: posByOrderId.get(order.id) ?? [],
      mfgCostTotal: Math.round(mfgCostTotal * 100) / 100,
      grossMarginTotal: Math.round(grossMarginTotal * 100) / 100,
    };
  });

  return { entries };
}

export async function exportAllCustomersPdf(): Promise<{
  customerCount: number;
  addressCount: number;
  customPriceCount: number;
}> {
  const [agency, customersData] = await Promise.all([fetchAgencySettingsForPdf(), fetchAllCustomersPdfData()]);
  generateAllCustomersPdf({ agency, ...customersData });
  return {
    customerCount: customersData.customers.length,
    addressCount: customersData.addresses.length,
    customPriceCount: customersData.customPrices.length,
  };
}

export async function exportSingleCustomerPdf(customerId: string): Promise<{
  businessName: string;
  orderCount: number;
}> {
  const [agency, custRes, addresses, rawCustomPrices, orders, invoices, payments] = await Promise.all([
    fetchAgencySettingsForPdf(),
    supabase.from("customers").select("*").eq("id", customerId).single(),
    fetchAllRows<CustomerAddress>((from, to) =>
      supabase
        .from("customer_addresses")
        .select("*")
        .eq("customer_id", customerId)
        .order("is_default", { ascending: false })
        .order("created_at")
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<RawCustomPriceRow>((from, to) =>
      supabase
        .from("customer_product_prices")
        .select(
          "id, customer_id, product_id, custom_selling_price, is_active, products(name, sku, product_prices(published_selling_price, published_manufacturer_price, draft_manufacturer_price))"
        )
        .eq("customer_id", customerId)
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<OrderRecord>((from, to) =>
      supabase
        .from("orders")
        .select("*")
        .eq("customer_id", customerId)
        .order("placed_at", { ascending: false })
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<InvoiceRecord>((from, to) =>
      supabase
        .from("invoices")
        .select("*")
        .eq("customer_id", customerId)
        .order("invoice_date", { ascending: false })
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<PaymentRecord>((from, to) =>
      supabase
        .from("payments")
        .select("*")
        .eq("customer_id", customerId)
        .order("payment_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    ),
  ]);

  if (custRes.error || !custRes.data) {
    throw new Error(custRes.error?.message || "Customer profile not found");
  }
  const customer = custRes.data as CustomerProfile;
  const nameMap = new Map([[customer.id, customer.business_name]]);
  const orderNumberById = new Map(orders.map((o) => [o.id, o.order_number]));
  const invoiceMetaById = new Map(
    invoices.map((inv) => [inv.id, { invoice_number: inv.invoice_number, order_number: orderNumberById.get(inv.order_id) }])
  );

  generateCustomerDetailPdf({
    agency,
    customer,
    addresses,
    customPrices: rawCustomPrices.map((cp) => mapCustomPriceRow(cp, nameMap)),
    orders,
    invoices,
    payments: payments.map((p) => ({
      ...p,
      invoice_number: invoiceMetaById.get(p.invoice_id)?.invoice_number,
      order_number: invoiceMetaById.get(p.invoice_id)?.order_number,
    })),
  });

  return {
    businessName: customer.business_name,
    orderCount: orders.length,
  };
}

export async function exportAllManufacturersPdf(): Promise<{
  manufacturerCount: number;
  productCount: number;
  poCount: number;
}> {
  const [agency, mfgData] = await Promise.all([fetchAgencySettingsForPdf(), fetchAllManufacturersPdfData()]);
  generateAllManufacturersPdf({ agency, ...mfgData });
  return {
    manufacturerCount: mfgData.manufacturers.length,
    productCount: mfgData.products.length,
    poCount: mfgData.purchaseOrders.length,
  };
}

export async function exportSingleManufacturerPdf(manufacturerId: string): Promise<{
  companyName: string;
  productCount: number;
  poCount: number;
}> {
  const [agency, mfgRes, products, purchaseOrders] = await Promise.all([
    fetchAgencySettingsForPdf(),
    supabase
      .from("manufacturers")
      .select("*, manufacturer_categories(category_id, categories(id, name))")
      .eq("id", manufacturerId)
      .single(),
    fetchAllRows<AdminProduct>((from, to) =>
      supabase
        .from("products")
        .select("*, manufacturer:manufacturers(id, company_name, status), category:categories(id, name, slug), product_prices(*), inventory(*)")
        .eq("manufacturer_id", manufacturerId)
        .order("name")
        .order("id")
        .range(from, to)
    ),
    fetchAllRows<PurchaseOrderRecord>((from, to) =>
      supabase
        .from("purchase_orders")
        .select("*, manufacturers(id, company_name), orders(id, order_number, order_status)")
        .eq("manufacturer_id", manufacturerId)
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    ),
  ]);

  if (mfgRes.error || !mfgRes.data) {
    throw new Error(mfgRes.error?.message || "Manufacturer not found");
  }
  const rawMfg = mfgRes.data as unknown as RawManufacturerRow;
  const manufacturer: ManufacturerWithCategories = {
    ...rawMfg,
    categories: (rawMfg.manufacturer_categories ?? [])
      .map((mc) => mc.categories)
      .filter((c): c is Pick<Category, "id" | "name"> => Boolean(c)),
  };

  generateManufacturerDetailPdf({
    agency,
    manufacturer,
    products,
    purchaseOrders,
  });

  return {
    companyName: manufacturer.company_name,
    productCount: products.length,
    poCount: purchaseOrders.length,
  };
}

export async function exportAllOrdersPdf(): Promise<{
  orderCount: number;
  lineItemCount: number;
}> {
  const [agency, ordersData] = await Promise.all([fetchAgencySettingsForPdf(), fetchAllOrdersPdfData()]);
  generateAllOrdersDetailsPdf({ agency, ...ordersData });
  return {
    orderCount: ordersData.entries.length,
    lineItemCount: ordersData.entries.reduce((s, e) => s + e.items.length, 0),
  };
}

export async function exportSingleOrderPdf(orderId: string): Promise<{
  orderNumber: string;
  lineItemCount: number;
}> {
  const [agency, orderRes, rawItems, invoiceRes, purchaseOrders] = await Promise.all([
    fetchAgencySettingsForPdf(),
    supabase.from("orders").select("*, customers(*)").eq("id", orderId).single(),
    fetchAllRows<RawDetailedOrderItem>((from, to) =>
      supabase
        .from("order_items")
        .select(
          "*, order_item_financials(*), purchase_order_items(id, purchase_order_id, purchase_orders(id, po_number, status))"
        )
        .eq("order_id", orderId)
        .order("created_at")
        .order("id")
        .range(from, to)
    ),
    supabase.from("invoices").select("*").eq("order_id", orderId).maybeSingle(),
    fetchAllRows<PurchaseOrderRecord>((from, to) =>
      supabase
        .from("purchase_orders")
        .select("*, manufacturers(id, company_name)")
        .eq("source_order_id", orderId)
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    ),
  ]);

  if (orderRes.error || !orderRes.data) {
    throw new Error(orderRes.error?.message || "Order not found");
  }
  const order = orderRes.data as unknown as RawOrderWithCustomer;
  const invoice = (invoiceRes.data as InvoiceRecord | null) ?? null;

  let payments: PaymentRecord[] = [];
  if (invoice?.id) {
    payments = await fetchAllRows<PaymentRecord>((from, to) =>
      supabase
        .from("payments")
        .select("*")
        .eq("invoice_id", invoice.id)
        .order("payment_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    );
  }

  let mfgCostTotal = 0;
  let grossMarginTotal = 0;
  const items: PdfDetailedOrderItem[] = rawItems.map((raw) => {
    const fin = firstOrObj(raw.order_item_financials);
    if (fin) {
      mfgCostTotal += Number(fin.unit_manufacturer_price ?? 0) * Number(raw.quantity ?? 0);
      grossMarginTotal += Number(fin.margin_amount_total ?? 0);
    }
    const linkedPoNumbers = (raw.purchase_order_items ?? [])
      .map((poi) => poi.purchase_orders)
      .filter((po): po is { id: string; po_number: string; status: string } => Boolean(po && po.status !== "Cancelled"))
      .map((po) => po.po_number);
    return {
      ...raw,
      financial: fin,
      linkedPoNumbers: Array.from(new Set(linkedPoNumbers)),
    };
  });

  generateAdminOrderDetailPdf({
    agency,
    entry: {
      order,
      items,
      invoice,
      payments,
      purchaseOrders,
      mfgCostTotal: Math.round(mfgCostTotal * 100) / 100,
      grossMarginTotal: Math.round(grossMarginTotal * 100) / 100,
    },
  });

  return {
    orderNumber: order.order_number,
    lineItemCount: items.length,
  };
}

export async function exportMasterBusinessDataPdf(): Promise<{
  customerCount: number;
  manufacturerCount: number;
  productCount: number;
  orderCount: number;
}> {
  const [agency, customersData, manufacturersData, ordersData] = await Promise.all([
    fetchAgencySettingsForPdf(),
    fetchAllCustomersPdfData(),
    fetchAllManufacturersPdfData(),
    fetchAllOrdersPdfData(),
  ]);

  generateMasterBusinessDataPdf({
    agency,
    customersData,
    manufacturersData,
    ordersData,
  });

  return {
    customerCount: customersData.customers.length,
    manufacturerCount: manufacturersData.manufacturers.length,
    productCount: manufacturersData.products.length,
    orderCount: ordersData.entries.length,
  };
}
