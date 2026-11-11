import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, MapPin, Plus, Trash2, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatDate } from "@/lib/utils";
import type { CustomerAddress } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

export function CustomerProfilePage() {
  const { customerProfile, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [phone, setPhone] = useState(customerProfile?.phone || "");
  const [ownerName, setOwnerName] = useState(customerProfile?.owner_name || "");
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    if (customerProfile) {
      setOwnerName(customerProfile.owner_name || "");
      setPhone(customerProfile.phone || "");
    }
  }, [customerProfile?.id, customerProfile?.owner_name, customerProfile?.phone]);

  const [label, setLabel] = useState("Branch Warehouse");
  const [addrLine, setAddrLine] = useState("");
  const [city, setCity] = useState("");
  const [stateVal, setStateVal] = useState("Telangana");
  const [pincode, setPincode] = useState("");
  const [addingAddr, setAddingAddr] = useState(false);

  const { data: addresses = [] } = useQuery({
    queryKey: ["customer-addresses", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () => {
      const { data } = await supabase
        .from("customer_addresses")
        .select("*")
        .eq("customer_id", customerProfile!.id)
        .order("is_default", { ascending: false });
      return (data ?? []) as CustomerAddress[];
    },
  });

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerProfile) return;
    setSavingProfile(true);
    try {
      const { error } = await supabase.rpc("update_own_customer_profile", {
        p_owner_name: ownerName.trim(),
        p_phone: phone.trim(),
      });
      if (error) throw error;
      await refreshProfile();
      toast({ title: "Business contact details updated", type: "success" });
    } catch (err) {
      toast({ title: "Update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAddAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerProfile) return;
    setAddingAddr(true);
    try {
      const { error } = await supabase.from("customer_addresses").insert({
        customer_id: customerProfile.id,
        label: label.trim(),
        contact_name: ownerName,
        contact_phone: phone,
        address_line: addrLine.trim(),
        city: city.trim(),
        state: stateVal.trim(),
        pincode: pincode.trim(),
        is_default: addresses.length === 0,
      });
      if (error) throw error;
      setAddrLine("");
      setCity("");
      setPincode("");
      toast({ title: "Delivery address added", type: "success" });
      queryClient.invalidateQueries({ queryKey: ["customer-addresses"] });
    } catch (err) {
      toast({ title: "Could not add address", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setAddingAddr(false);
    }
  };

  const deleteAddress = async (addrId: string) => {
    const { error } = await supabase.from("customer_addresses").delete().eq("id", addrId);
    if (error) {
      toast({ title: "Could not delete address", description: error.message, type: "error" });
      return;
    }
    toast({ title: "Delivery address removed", type: "info" });
    queryClient.invalidateQueries({ queryKey: ["customer-addresses"] });
  };

  if (!customerProfile) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">My Business Profile</h1>
        <p className="text-sm text-slate-500">Registered company details and delivery destinations.</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-blue-700" />
            {customerProfile.business_name}
          </CardTitle>
          <StatusBadge status={customerProfile.status} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs text-slate-500">Login Email</p>
              <p className="break-all font-medium">{customerProfile.email}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">GST Number</p>
              <p className="font-mono font-medium">{customerProfile.gst_number || "Not provided"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Member Since</p>
              <p className="font-medium">{formatDate(customerProfile.registered_at)}</p>
            </div>
          </div>

          <form onSubmit={handleSaveProfile} className="grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-3 items-end">
            <div className="space-y-1.5">
              <Label>Authorized Contact / Owner</Label>
              <Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Phone Number</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} required />
            </div>
            <Button type="submit" disabled={savingProfile}>
              {savingProfile && <Loader2 className="h-4 w-4 animate-spin" />}
              Update Contact Info
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-blue-700" />
            Delivery Addresses ({addresses.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {addresses.map((a) => (
              <div key={a.id} className="flex items-start justify-between gap-2 rounded-md border border-slate-200 p-3.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-slate-900">
                    {a.label} {a.is_default && <span className="ml-1 text-[11px] text-blue-700">(Default)</span>}
                  </p>
                  <p className="mt-1 break-words text-xs text-slate-600">
                    {a.address_line}, {a.city}, {a.state} - {a.pincode}
                  </p>
                </div>
                <Button variant="ghost" size="icon" className="shrink-0 text-red-600" onClick={() => deleteAddress(a.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <form onSubmit={handleAddAddress} className="grid grid-cols-1 items-end gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Street / Warehouse Address</Label>
              <Input value={addrLine} onChange={(e) => setAddrLine(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>City &amp; State</Label>
              <div className="grid grid-cols-2 gap-1.5">
                <Input placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} required />
                <Input placeholder="State" value={stateVal} onChange={(e) => setStateVal(e.target.value)} required />
              </div>
            </div>
            <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
              <Input placeholder="Pincode" value={pincode} onChange={(e) => setPincode(e.target.value)} required />
              <Button type="submit" className="shrink-0" disabled={addingAddr}>
                {addingAddr ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
