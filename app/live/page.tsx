// The live judge lane: the same story layout, its left column is the five steps of the judge. It needs the token and POST /api/shop/snapshot;
// without them it says so and plays the recorded run instead.
import type { Metadata } from "next";
import { allStories } from "../../lib/ui/source.ts";
import { LiveLane } from "../_components/live-lane.tsx";

export const metadata: Metadata = { title: "Live lane | Doorbell" };

export default function Page() {
  return <LiveLane stories={allStories()} />;
}
