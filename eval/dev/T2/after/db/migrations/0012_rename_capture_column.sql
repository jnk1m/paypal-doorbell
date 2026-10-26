-- Align column names with the new accounting export.
ALTER TABLE orders RENAME COLUMN pp_capture_id TO paypal_capture_id;
ALTER TABLE orders RENAME COLUMN pp_order_id TO paypal_order_id;
