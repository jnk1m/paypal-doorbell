// /stamp was the rough screen of the first comprehension test; the live lane (/live) replaced it.
import { redirect } from "next/navigation";

export default function Page(): never {
  redirect("/live");
}
