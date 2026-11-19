// Production smoke through the visible Friends and Join controls in disposable browser profiles.
// Set COOP_PUBLIC_ORIGIN to the exact HTTPS deployment being verified.
export default async function publicInvite({ host, guest, sleep }) {
  const origin = new URL(process.env.COOP_PUBLIC_ORIGIN).origin;
  const until = async (page, expression, label) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = await page.evaluate(expression, 8000).catch(() => null);
      if (result) return result;
      await sleep(250);
    }
    const detail = await page.evaluate("document.body.innerText.slice(-600)");
    throw Error(label + " timed out: " + detail);
  };
  const click = (page, expression, label) => until(page,
    "(() => { const el = (" + expression + "); if (!el || el.disabled) return false; el.click(); return true; })()", label);
  const select = (selector) => "document.querySelector(" + JSON.stringify(selector) + ")";
  const button = (label) => "[...document.querySelectorAll('button')].find(b => b.innerText.trim().toLowerCase().startsWith(" + JSON.stringify(label) + "))";
  const friends = async page => {
    await click(page, select(".settings__open-button"), "Settings");
    await click(page, button("friends"), "Friends");
  };
  try {
    await host.send("Page.navigate", { url: origin + "/?autostart=1" });
    await friends(host);
    await click(host, button("open to friends"), "Host");
    const code = await until(host, "document.querySelector('.coop-settings__code')?.textContent", "Invite code");
    await guest.send("Page.navigate", { url: origin + "/?join=" + encodeURIComponent(code) });
    await click(guest, select("[data-coop-join]"), "Join");
    await until(guest, select('.coop-pill[data-status="joined"]') + " !== null", "Guest admission");
    await until(host, "document.querySelector('.coop-pill__n')?.textContent.includes('2/')", "Host seat count");
    await friends(guest);
    await until(guest, "document.querySelector('.coop-settings')?.innerText.includes('Direct connection')", "ICE route");
    await click(guest, button("share my position"), "Publish rendezvous");
    await until(guest, "document.querySelector('.coop-settings__expedition [role=status]')?.textContent === 'Position shared'", "Marker committed");
    await click(guest, button("clear my marker"), "Clear rendezvous");
    await until(guest, "document.querySelector('.coop-settings__expedition [role=status]')?.textContent === 'Marker cleared'", "Marker cleared");
    await click(host, button("stop hosting"), "Close room");
    await until(host, button("open to friends") + " !== undefined", "Host returned to solo");
    return { pass: true, origin, seats: 2, route: "direct", markerRoundTrip: true, closed: true };
  } finally {
    await Promise.all([host, guest].map(page => page.send("Page.navigate", { url: "about:blank" })));
  }
}
