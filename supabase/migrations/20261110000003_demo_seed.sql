-- ============================================================================
-- OPTIONAL DEMO DATA SEED (Clearly tagged for development & verification)
-- ============================================================================

-- Base Standard B2B Categories
INSERT INTO public.categories (name, slug, description, status, sort_order) VALUES
  ('Electronics', 'electronics', 'Consumer and commercial electronic equipment and accessories', 'active', 1),
  ('Electrical Equipment', 'electrical-equipment', 'Switches, MCBs, industrial cables, and LED lighting systems', 'active', 2),
  ('Grocery', 'grocery', 'Bulk food staples, grains, oils, and packaged FMCG goods', 'active', 3),
  ('Furniture', 'furniture', 'Commercial office desks, ergonomic seating, and storage racks', 'active', 4),
  ('Clothing', 'clothing', 'Wholesale apparel, uniforms, and textile supplies', 'active', 5),
  ('Medical Supplies', 'medical-supplies', 'Clinical consumables, PPE, diagnostics, and pharmacy stock', 'active', 6),
  ('Hardware', 'hardware', 'Fasteners, hand tools, locks, and industrial fittings', 'active', 7),
  ('Home Appliances', 'home-appliances', 'Kitchen appliances, ceiling fans, and climate equipment', 'active', 8),
  ('Stationery', 'stationery', 'Office paper, printers, filing supplies, and commercial stationery', 'active', 9),
  ('Construction Materials', 'construction-materials', 'Adhesives, paints, plumbing fittings, and building supplies', 'active', 10)
ON CONFLICT (slug) DO NOTHING;

-- Category-wise Margin Rules (Demo defaults matching specification examples)
INSERT INTO public.margin_rules (scope, category_id, margin_percentage, notes)
SELECT 'category', id, 15.00, '[DEMO] Electronics category margin'
FROM public.categories WHERE slug = 'electronics'
ON CONFLICT DO NOTHING;

INSERT INTO public.margin_rules (scope, category_id, margin_percentage, notes)
SELECT 'category', id, 20.00, '[DEMO] Furniture category margin'
FROM public.categories WHERE slug = 'furniture'
ON CONFLICT DO NOTHING;

INSERT INTO public.margin_rules (scope, category_id, margin_percentage, notes)
SELECT 'category', id, 10.00, '[DEMO] Grocery category margin'
FROM public.categories WHERE slug = 'grocery'
ON CONFLICT DO NOTHING;

INSERT INTO public.margin_rules (scope, category_id, margin_percentage, notes)
SELECT 'category', id, 25.00, '[DEMO] Clothing category margin'
FROM public.categories WHERE slug = 'clothing'
ON CONFLICT DO NOTHING;

-- Demo Manufacturers (clearly marked [DEMO])
INSERT INTO public.manufacturers (company_name, contact_person, phone, email, website, address, city, state, gst_number, description, status)
VALUES
  ('[DEMO] ABC Electronics Pvt Ltd', 'Rajesh Kumar', '+91 98480 11223', 'supply@abcelectronics-demo.in', 'https://abcelectronics-demo.in', 'Plot 42, IDA Cherlapally', 'Hyderabad', 'Telangana', '36AABCA1234F1Z5', 'ISO-certified LED lighting and electrical accessories manufacturer.', 'active'),
  ('[DEMO] XYZ Industries Ltd', 'Anita Sharma', '+91 98480 33445', 'b2b@xyzindustries-demo.in', 'https://xyzindustries-demo.in', 'Phase II, Jeedimetla Industrial Park', 'Hyderabad', 'Telangana', '36AAXCX5678G1Z9', 'Commercial switchgear, wiring, and industrial hardware producer.', 'active'),
  ('[DEMO] Bright Technologies', 'Vikram Patel', '+91 98250 77889', 'orders@brighttech-demo.in', 'https://brighttech-demo.in', 'GIDC Electronic Zone', 'Ahmedabad', 'Gujarat', '24AAACB9012H1Z2', 'Smart home appliances and high-efficiency ceiling fans manufacturer.', 'active'),
  ('[DEMO] Apex Workspace Furnishings', 'Meera Nair', '+91 98450 55667', 'trade@apexfurnish-demo.in', 'https://apexfurnish-demo.in', 'Peenya Industrial Area', 'Bengaluru', 'Karnataka', '29AAACA4321K1Z8', 'Modular office workstations, chairs, and heavy-duty steel shelving.', 'active')
ON CONFLICT DO NOTHING;

-- Associate demo manufacturers to categories (including multi-category mapping)
INSERT INTO public.manufacturer_categories (manufacturer_id, category_id)
SELECT m.id, c.id FROM public.manufacturers m, public.categories c
WHERE m.company_name = '[DEMO] ABC Electronics Pvt Ltd' AND c.slug IN ('electronics', 'electrical-equipment')
ON CONFLICT DO NOTHING;

INSERT INTO public.manufacturer_categories (manufacturer_id, category_id)
SELECT m.id, c.id FROM public.manufacturers m, public.categories c
WHERE m.company_name = '[DEMO] XYZ Industries Ltd' AND c.slug IN ('electronics', 'electrical-equipment', 'hardware')
ON CONFLICT DO NOTHING;

INSERT INTO public.manufacturer_categories (manufacturer_id, category_id)
SELECT m.id, c.id FROM public.manufacturers m, public.categories c
WHERE m.company_name = '[DEMO] Bright Technologies' AND c.slug IN ('electronics', 'home-appliances')
ON CONFLICT DO NOTHING;

INSERT INTO public.manufacturer_categories (manufacturer_id, category_id)
SELECT m.id, c.id FROM public.manufacturers m, public.categories c
WHERE m.company_name = '[DEMO] Apex Workspace Furnishings' AND c.slug IN ('furniture', 'stationery')
ON CONFLICT DO NOTHING;
