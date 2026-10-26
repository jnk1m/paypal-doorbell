// Maple Mug's price list. It lives on the server: the browser sends an item id, never an amount (plan 9.6, R13).
export interface Item {
  name: string;
  price: string; // USD, two decimals
}

export const CATALOG = {
  "ethiopia-250": { name: "Ethiopia Yirgacheffe, 250 g", price: "18.00" },
  "colombia-250": { name: "Colombia Huila, 250 g", price: "16.50" },
  "house-250": { name: "House blend, 250 g", price: "14.00" },
  "gift-set": { name: "Gift set: three coffees and a mug", price: "48.00" },
} as const satisfies Record<string, Item>;

export type ItemId = keyof typeof CATALOG;
export const isItemId = (v: unknown): v is ItemId => typeof v === "string" && Object.hasOwn(CATALOG, v);
