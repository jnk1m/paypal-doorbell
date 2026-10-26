// The landing is the recorded run (plan 5.6, R12): five real scenarios captured from the deployed shop, played back as one incident story. It makes
// no request to PayPal, Redis or an AI service and needs no key. The stories are built here, on the server, from lib/run/recorded.ts; the
// browser receives the stories, not the recording.
import { allStories } from "../lib/ui/source.ts";
import { StoryView } from "./_components/story-view.tsx";

export default function Page() {
  return <StoryView stories={allStories()} />;
}
