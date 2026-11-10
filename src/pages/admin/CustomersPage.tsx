import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Building2, Eye, Pencil, Power, Loader2 } from "lucide-react";
import { invokeAuthenticatedFunction, supabase } from "@/lib/supabase";
import { formatDate } from "@/lib/utils";
import type { CustomerProfile } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

export function CustomersPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerProfile | null>(null);
  const [saving, setSaving] = useState(false);

  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [stateVal, setStateVal] = useState("Telangana");
  const [pincode, setPincode] = useState("");
  const [gstNumber, setGstNumber] = useState("");
  const [businessCategory, setBusinessCategory] = useState("");
  const [status, setStatus] = useState<"active" | "inactive" | "suspended">("active");

  const { data: customers = [], isLoading } = useQuery({
    queryKey: ["admin-customers"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CustomerProfile[];
    },
  });

  const openCreate = () => {
    setEditing(null);
    setBusinessName("");
    setOwnerName("");
    setPhone("");
    setEmail("");
    setPassword("");
    setAddress("");
    setCity("");
    setStateVal("Telangana");
    setPincode("");
    setGstNumber("");
    setBusinessCategory("");
    setStatus("active");
    setModalOpen(true);
  };

  const openEdit = (c: CustomerProfile) => {
    setEditing(c);
    setBusinessName(c.business_name);
    setOwnerName(c.owner_name);
    setPhone(c.phone);
    setEmail(c.email);
    setPassword("");
    setAddress(c.business_address);
    setCity(c.city || "");
    setStateVal(c.state || "Telangana");
    setPincode(c.pincode || "");
    setGstNumber(c.gst_number || "");
    setBusinessCategory(c.business_category || "");
    setStatus(c.status);
    setModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        const { error } = await supabase
          .from("customers")
          .update({
            business_name: businessName.trim(),
            owner_name: ownerName.trim(),
            phone: phone.trim(),
            business_address: address.trim(),
            city: city.trim() || null,
            state: stateVal.trim() || "Telangana",
            pincode: pincode.trim() || null,
            gst_number: gstNumber.trim().toUpperCase() || null,
            business_category: businessCategory.trim() || null,
            status,
          })
          .eq("id", editing.id);
        if (error) throw error;
        toast({ title: "Customer business updated", type: "success" });
      } else {
        await invokeAuthenticatedFunction(
          "create-customer-user",
          {
            business_name: businessName.trim(),
            owner_name: ownerName.trim(),
            phone: phone.trim(),
            email: email.trim().toLowerCase(),
            password,
            business_address: address.trim(),
            city: city.trim(),
            state: stateVal.trim(),
            pincode: pincode.trim(),
            gst_number: gstNumber.trim().toUpperCase(),
            business_category: businessCategory.trim(),
            status,
          },
          "Failed to provision customer login"
        );
        toast({
          title: "Customer registered & login created",
          description: `Credentials created for ${email.trim().toLowerCase()}`,
          type: "success",
        });
      }

      setModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin-customers"] });
    } catch (err) {
      toast({
        title: "Failed to save customer",
        description: err instanceof Error ? err.message : "Error",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (c: CustomerProfile) => {
    const nextActive = c.status !== "active";
    try {
      if (c.user_id) {
        try {
          await invokeAuthenticatedFunction(
            "manage-staff-user",
            { action: "toggle_user_status", user_id: c.user_id, is_active: nextActive },
            "Failed to update user status"
          );
        } catch (fnErr) {
          const msg = fnErr instanceof Error ? fnErr.message : "";
          if (/expired|signed out|sign in/i.test(msg)) {
            throw fnErr;
          }
          // Staff might not have admin-level ban rights, fallback to updating customer table status
          const { error: custErr } = await supabase
            .from("customers")
            .update({ status: nextActive ? "active" : "inactive" })
            .eq("id", c.id);
          if (custErr) throw custErr;
        }
      } else {
        const { error } = await supabase
          .from("customers")
          .update({ status: nextActive ? "active" : "inactive" })
          .eq("id", c.id);
        if (error) throw error;
      }
      toast({
        title: `Customer ${nextActive ? "activated" : "deactivated"}`,
        type: "info",
      });
      queryClient.invalidateQueries({ queryKey: ["admin-customers"] });
    } catch (err) {
      toast({ title: "Status update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    }
  };

  const filtered = customers.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    const q = search.toLowerCase();
    return (
      !q ||
      c.business_name.toLowerCase().includes(q) ||
      c.owner_name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.gst_number || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Customer Management</h1>
          <p className="text-sm text-slate-500">
            Manage registered local businesses, login credentials, outstanding dues, and custom pricing.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          Add Customer Business
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-blue-700" />
            Registered Businesses ({filtered.length})
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search business, owner, GST..."
              className="sm:w-64"
            />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Business</TableHead>
                <TableHead>Owner &amp; Contact</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead>Registered</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    Loading customers...
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                    No registered businesses found.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link to={`/admin/customers/${c.id}`} className="font-semibold text-slate-900 hover:underline">
                        {c.business_name}
                      </Link>
                      <p className="text-xs text-slate-500">{c.business_category || "Local Business"}</p>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm font-medium text-slate-800">{c.owner_name}</p>
                      <p className="text-xs text-slate-500">
                        {c.phone} &bull; {c.email}
                      </p>
                    </TableCell>
                    <TableCell className="text-xs text-slate-600">
                      {[c.city, c.state].filter(Boolean).join(", ")}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-slate-600">{c.gst_number || "—"}</TableCell>
                    <TableCell className="text-xs text-slate-500">{formatDate(c.registered_at)}</TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-1">
                        <Link
                          to={`/admin/customers/${c.id}`}
                          className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          Profile
                        </Link>
                        <Button variant="ghost" size="icon" onClick={() => openEdit(c)} title="Edit">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleStatus(c)}
                          title={c.status === "active" ? "Deactivate" : "Activate"}
                        >
                          <Power className={c.status === "active" ? "h-4 w-4 text-amber-600" : "h-4 w-4 text-emerald-600"} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Customer Business" : "Register New Customer Business"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Business Name *</Label>
                <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Owner / Primary Contact Name *</Label>
                <Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Phone Number *</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Login Email *</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={Boolean(editing)}
                />
              </div>
            </div>

            {!editing && (
              <div className="space-y-1.5">
                <Label>Initial Portal Password (min 8 chars) *</Label>
                <Input
                  type="password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="Provided to business owner for Customer Portal login"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Business Address *</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} required />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>City</Label>
                <Input value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>State *</Label>
                <Input value={stateVal} onChange={(e) => setStateVal(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Pincode</Label>
                <Input value={pincode} onChange={(e) => setPincode(e.target.value)} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>GST Number</Label>
                <Input value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Business Category</Label>
                <Input
                  value={businessCategory}
                  onChange={(e) => setBusinessCategory(e.target.value)}
                  placeholder="Retail / Hardware Store / Office"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Account Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as "active" | "inactive" | "suspended")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="suspended">Suspended</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? "Save Changes" : "Create Customer Account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
