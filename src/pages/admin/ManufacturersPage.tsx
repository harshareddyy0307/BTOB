import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Factory, FolderPlus, Pencil, Trash2, Eye, Upload, Loader2, ArrowLeft } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { uploadStorageFile } from "@/lib/storage";
import { slugify } from "@/lib/utils";
import type { Category, Manufacturer } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

interface ManufacturerWithCats extends Manufacturer {
  manufacturer_categories: { category_id: string; categories: Pick<Category, "id" | "name"> }[];
}

export function ManufacturersPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"categories" | "directory">("categories");
  const [search, setSearch] = useState("");

  // Custom Category Modal
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatDesc, setNewCatDesc] = useState("");
  const [savingCat, setSavingCat] = useState(false);

  // Manufacturer Add/Edit Modal
  const [mfgModalOpen, setMfgModalOpen] = useState(false);
  const [editingMfg, setEditingMfg] = useState<ManufacturerWithCats | null>(null);
  const [savingMfg, setSavingMfg] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const [companyName, setCompanyName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [stateVal, setStateVal] = useState("");
  const [gstNumber, setGstNumber] = useState("");
  const [description, setDescription] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [selectedCatIds, setSelectedCatIds] = useState<string[]>([]);

  const { data: categories = [] } = useQuery({
    queryKey: ["admin-categories"],
    queryFn: async () => {
      const { data, error } = await supabase.from("categories").select("*").order("sort_order").order("name");
      if (error) throw error;
      return (data ?? []) as Category[];
    },
  });

  const { data: manufacturers = [], isLoading } = useQuery({
    queryKey: ["admin-manufacturers"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("manufacturers")
        .select("*, manufacturer_categories(category_id, categories(id, name))")
        .order("company_name");
      if (error) throw error;
      return (data ?? []) as unknown as ManufacturerWithCats[];
    },
  });

  const openCreateMfg = (preselectCategoryId?: string | null) => {
    setEditingMfg(null);
    setCompanyName("");
    setContactPerson("");
    setPhone("");
    setEmail("");
    setWebsite("");
    setAddress("");
    setCity("");
    setStateVal("");
    setGstNumber("");
    setDescription("");
    setLogoUrl("");
    setStatus("active");
    setSelectedCatIds(preselectCategoryId ? [preselectCategoryId] : []);
    setMfgModalOpen(true);
  };

  const openEditMfg = (mfg: ManufacturerWithCats) => {
    setEditingMfg(mfg);
    setCompanyName(mfg.company_name);
    setContactPerson(mfg.contact_person);
    setPhone(mfg.phone);
    setEmail(mfg.email || "");
    setWebsite(mfg.website || "");
    setAddress(mfg.address);
    setCity(mfg.city || "");
    setStateVal(mfg.state || "");
    setGstNumber(mfg.gst_number || "");
    setDescription(mfg.description || "");
    setLogoUrl(mfg.logo_url || "");
    setStatus(mfg.status);
    setSelectedCatIds((mfg.manufacturer_categories ?? []).map((mc) => mc.category_id));
    setMfgModalOpen(true);
  };

  const toggleCatSelection = (catId: string) => {
    setSelectedCatIds((prev) => (prev.includes(catId) ? prev.filter((id) => id !== catId) : [...prev, catId]));
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    try {
      const { url } = await uploadStorageFile("brand-assets", "manufacturers", file);
      setLogoUrl(url);
      toast({ title: "Manufacturer logo uploaded", type: "success" });
    } catch (err) {
      toast({ title: "Logo upload failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSaveMfg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedCatIds.length === 0) {
      toast({ title: "Select at least one manufacturer category", type: "error" });
      return;
    }

    setSavingMfg(true);
    try {
      const payload = {
        company_name: companyName.trim(),
        contact_person: contactPerson.trim(),
        phone: phone.trim(),
        email: email.trim() || null,
        website: website.trim() || null,
        address: address.trim(),
        city: city.trim() || null,
        state: stateVal.trim() || null,
        gst_number: gstNumber.trim().toUpperCase() || null,
        description: description.trim() || null,
        logo_url: logoUrl.trim() || null,
        status,
      };

      let mfgId = editingMfg?.id;
      if (editingMfg) {
        const { error } = await supabase.from("manufacturers").update(payload).eq("id", editingMfg.id);
        if (error) throw error;
      } else {
        const { data: created, error } = await supabase.from("manufacturers").insert(payload).select("id").single();
        if (error || !created) throw error || new Error("Insert failed");
        mfgId = created.id;
      }

      await supabase.from("manufacturer_categories").delete().eq("manufacturer_id", mfgId);
      const joinRows = selectedCatIds.map((category_id) => ({ manufacturer_id: mfgId, category_id }));
      const { error: joinErr } = await supabase.from("manufacturer_categories").insert(joinRows);
      if (joinErr) throw joinErr;

      toast({ title: editingMfg ? "Manufacturer updated" : "Manufacturer added", type: "success" });
      setMfgModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin-manufacturers"] });
    } catch (err) {
      toast({ title: "Failed to save manufacturer", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSavingMfg(false);
    }
  };

  const handleDeleteMfg = async (mfg: ManufacturerWithCats) => {
    if (!confirm(`Delete manufacturer "${mfg.company_name}"?`)) return;
    const { error } = await supabase.from("manufacturers").delete().eq("id", mfg.id);
    if (error) {
      toast({ title: "Cannot delete manufacturer", description: error.message, type: "error" });
      return;
    }
    toast({ title: "Manufacturer deleted", type: "success" });
    queryClient.invalidateQueries({ queryKey: ["admin-manufacturers"] });
  };

  const handleCreateCustomCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingCat(true);
    try {
      const { error } = await supabase.from("categories").insert({
        name: newCatName.trim(),
        slug: slugify(newCatName),
        description: newCatDesc.trim() || null,
        status: "active",
      });
      if (error) throw error;
      toast({ title: "Custom category created", type: "success" });
      setNewCatName("");
      setNewCatDesc("");
      setCatModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin-categories"] });
    } catch (err) {
      toast({ title: "Could not create category", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSavingCat(false);
    }
  };

  const selectedCategory = categories.find((c) => c.id === selectedCategoryId) || null;

  const filteredManufacturers = manufacturers.filter((m) => {
    const matchesCat = selectedCategoryId
      ? (m.manufacturer_categories ?? []).some((mc) => mc.category_id === selectedCategoryId)
      : true;
    const q = search.toLowerCase();
    const matchesSearch =
      !q ||
      m.company_name.toLowerCase().includes(q) ||
      m.contact_person.toLowerCase().includes(q) ||
      (m.gst_number || "").toLowerCase().includes(q);
    return matchesCat && matchesSearch;
  });

  const countForCategory = (catId: string) =>
    manufacturers.filter((m) => (m.manufacturer_categories ?? []).some((mc) => mc.category_id === catId)).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Manufacturer Management</h1>
          <p className="text-sm text-slate-500">
            Internal agency-managed supplier profiles, categories, and catalogs. Manufacturers never log in.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setCatModalOpen(true)}>
            <FolderPlus className="h-4 w-4" />
            Custom Category
          </Button>
          <Button onClick={() => openCreateMfg(selectedCategoryId)}>
            <Plus className="h-4 w-4" />
            Add Manufacturer
          </Button>
        </div>
      </div>

      {/* Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === "categories" && !selectedCategoryId ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setSelectedCategoryId(null);
              setViewMode("categories");
            }}
          >
            Manufacturer Categories
          </Button>
          <Button
            variant={viewMode === "directory" && !selectedCategoryId ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setSelectedCategoryId(null);
              setViewMode("directory");
            }}
          >
            All Manufacturers ({manufacturers.length})
          </Button>
          {selectedCategory && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedCategoryId(null);
                setViewMode("categories");
              }}
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Categories
            </Button>
          )}
        </div>

        {(viewMode === "directory" || selectedCategoryId) && (
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search manufacturers by name, contact, GST..."
            className="sm:w-72"
          />
        )}
      </div>

      {/* Category Cards View */}
      {viewMode === "categories" && !selectedCategoryId && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {categories.map((cat) => {
            const mfgCount = countForCategory(cat.id);
            return (
              <Card
                key={cat.id}
                onClick={() => {
                  setSelectedCategoryId(cat.id);
                  setViewMode("directory");
                }}
                className="cursor-pointer transition-colors hover:border-blue-400"
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold text-slate-900">{cat.name}</h3>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                        {cat.description || "Click to inspect manufacturers supplying this category"}
                      </p>
                    </div>
                    <Factory className="h-5 w-5 shrink-0 text-blue-700" />
                  </div>
                  <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs">
                    <span className="font-semibold text-slate-700">{mfgCount} Manufacturer(s)</span>
                    <StatusBadge status={cat.status} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Manufacturers Directory Table */}
      {(viewMode === "directory" || selectedCategoryId) && (
        <Card>
          <CardHeader>
            <CardTitle>
              {selectedCategory ? `${selectedCategory.name} — Manufacturers` : "All Registered Manufacturers"} (
              {filteredManufacturers.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Contact Person</TableHead>
                  <TableHead>Categories</TableHead>
                  <TableHead>GST Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                      Loading manufacturers...
                    </TableCell>
                  </TableRow>
                ) : filteredManufacturers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                      No manufacturers found in this view.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredManufacturers.map((mfg) => (
                    <TableRow key={mfg.id}>
                      <TableCell>
                        <Link to={`/admin/manufacturers/${mfg.id}`} className="flex items-center gap-3 hover:underline">
                          {mfg.logo_url ? (
                            <img src={mfg.logo_url} alt={mfg.company_name} className="h-9 w-9 rounded border object-cover" />
                          ) : (
                            <div className="flex h-9 w-9 items-center justify-center rounded border bg-slate-100 text-xs font-bold text-slate-600">
                              {mfg.company_name.slice(0, 2).toUpperCase()}
                            </div>
                          )}
                          <div>
                            <p className="font-semibold text-slate-900">{mfg.company_name}</p>
                            <p className="text-xs text-slate-500">
                              {[mfg.city, mfg.state].filter(Boolean).join(", ") || mfg.address}
                            </p>
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm font-medium text-slate-800">{mfg.contact_person}</p>
                        <p className="text-xs text-slate-500">{mfg.phone}</p>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(mfg.manufacturer_categories ?? []).map((mc) => (
                            <span
                              key={mc.category_id}
                              className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                            >
                              {mc.categories?.name}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs font-mono text-slate-600">{mfg.gst_number || "—"}</TableCell>
                      <TableCell>
                        <StatusBadge status={mfg.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Link
                            to={`/admin/manufacturers/${mfg.id}`}
                            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Profile &amp; Products
                          </Link>
                          <Button variant="ghost" size="icon" onClick={() => openEditMfg(mfg)} title="Edit">
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteMfg(mfg)}
                            className="text-red-600 hover:text-red-700"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
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
      )}

      {/* Custom Category Modal */}
      <Dialog open={catModalOpen} onOpenChange={setCatModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Custom Manufacturer Category</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateCustomCategory} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Category Name *</Label>
              <Input
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="e.g. Packaging & Corrugated Boxes"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea value={newCatDesc} onChange={(e) => setNewCatDesc(e.target.value)} rows={2} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCatModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={savingCat}>
                {savingCat && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Category
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add / Edit Manufacturer Modal */}
      <Dialog open={mfgModalOpen} onOpenChange={setMfgModalOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editingMfg ? "Edit Manufacturer" : "Add New Manufacturer"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSaveMfg} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Company Name *</Label>
                <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Contact Person *</Label>
                <Input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} required />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Phone Number *</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>GST Number</Label>
                <Input value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} placeholder="36AABCA1234F1Z5" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Website</Label>
                <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://..." />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as "active" | "inactive")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Address *</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} required />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>City</Label>
                <Input value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>State</Label>
                <Input value={stateVal} onChange={(e) => setStateVal(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Company Logo</Label>
              <div className="flex items-center gap-3">
                <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="Logo URL or upload" />
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  {uploadingLogo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  <span>Upload</span>
                  <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
                </label>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Associated Categories (Multiple Allowed) *</Label>
              <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto rounded-md border border-slate-200 p-3 sm:grid-cols-3">
                {categories.map((cat) => {
                  const checked = selectedCatIds.includes(cat.id);
                  return (
                    <label
                      key={cat.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCatSelection(cat.id)}
                        className="rounded border-slate-300"
                      />
                      <span className="truncate font-medium text-slate-700">{cat.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Company Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMfgModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={savingMfg}>
                {savingMfg && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingMfg ? "Save Manufacturer" : "Create Manufacturer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
