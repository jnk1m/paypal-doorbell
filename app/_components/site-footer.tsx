// The page footer.
export function SiteFooter({ live = true }: { live?: boolean }) {
  return (
    <footer>
      <p>
        Doorbell, a webhook gap finder for PayPal. MIT licence.{live ? " " : null}
        {live ? <a href="/live">Run it yourself in the live lane</a> : null}
      </p>
    </footer>
  );
}
