import { useEffect, useState } from "react";

// Live Meeting Room — photo composition is kept exactly as the mockup:
// background = room.jpg, SAM-cut layers at their original bboxes.
// Animation is per character, on its own layer only.
// Blink: real eye centres found by dark-blob detection (verified by
// drawing ellipses at the detected centres on room.jpg — all 12 land
// on real eyes). Two earlier bugs are fixed here, not repeated:
//  1. Overlay size: eyes in the photo are only ~14px wide / ~18px tall,
//     so a 3.2%-wide overlay was a big pale patch, not a blink.
//     Now the overlay is 1.6% x 5.0% — about one eye, no more.
//  2. Colour: the generic pale #f2e3c9 looked white against the
//     characters' pink/tan faces. Each character now uses its own
//     skin colour, sampled from pixels around its eyes in room.jpg.
//  3. Timing: fixed CSS delays made blinks march in sequence.
//     Now each character blinks on its own random timer
//     (1.8-5.2s apart, 220ms closed), so blinks look natural.

const LAYERS = [
  { id: "reader", label: "Reader", x: 34, y: 0, w: 271, h: 415, fur: "#7aa8e8" },
  { id: "citation", label: "Citation Matcher", x: 273, y: 0, w: 214, h: 274, fur: "#8fd0b8" },
  { id: "verifier", label: "Reference Verifier", x: 486, y: 0, w: 219, h: 231, fur: "#b8a8d8" },
  { id: "gap", label: "Gap Assessor", x: 767, y: 0, w: 181, h: 161, fur: "#e8d88a" },
  { id: "journal", label: "Journal Matcher", x: 943, y: 0, w: 177, h: 240, fur: "#e8b88a" },
  { id: "supervisor", label: "Supervisor", x: 1024, y: 46, w: 304, h: 369, fur: "#d8cdb8" },
  { id: "narrator", label: "Narrator", x: 683, y: 143, w: 353, h: 272, fur: "#666666" },
];
const PW = 1373, PH = 478;
const EYE_GROUPS = [
  { id: "reader", skin: "#e8c6b2", eyes: [[203, 131], [250, 125]] },
  { id: "citation", skin: "#eed2b9", eyes: [[399, 75], [441, 69]] },
  { id: "verifier", skin: "#e1b4a5", eyes: [[583, 62], [636, 60]] },
  { id: "gap", skin: "#dcaf7d", eyes: [[792, 66], [837, 69]] },
  { id: "journal", skin: "#d4a076", eyes: [[964, 97], [1004, 101]] },
  { id: "supervisor", skin: "#c89e7a", eyes: [[1117, 180], [1161, 173]] },
];

export default function MeetingRoom({ statuses, bubbles, live }) {
  const [blinking, setBlinking] = useState({});
  useEffect(() => {
    let cancelled = false;
    const timers = [];
    const schedule = (id, delay) => {
      const t = setTimeout(() => {
        if (cancelled) return;
        setBlinking((p) => ({ ...p, [id]: true }));
        const t2 = setTimeout(() => {
          if (cancelled) return;
          setBlinking((p) => ({ ...p, [id]: false }));
          schedule(id, 1800 + Math.random() * 3400);
        }, 220);
        timers.push(t2);
      }, delay);
      timers.push(t);
    };
    EYE_GROUPS.forEach((g) => schedule(g.id, Math.random() * 2000));
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, []);
  return (
    <div className="marva-room-wrap">
      <div className="marva-photo-room">
        <img className="marva-photo-bg" src="/room.jpg" alt="MARVA live meeting room: seven agents at a round table" />
        {LAYERS.map((c, ci) => {
          const active = statuses[c.id] === "running" || statuses[c.id] === "typing";
          return (
            <div
              key={c.id}
              className={`marva-photo-layer ${active ? "marva-typing" : ""}`}
              style={{
                left: `${(c.x / PW) * 100}%`, top: `${(c.y / PH) * 100}%`,
                width: `${(c.w / PW) * 100}%`, zIndex: c.id === "narrator" || c.id === "supervisor" || c.id === "reader" ? 3 : 2,
                animationDelay: `${(ci * 0.4).toFixed(1)}s`,
              }}
              title={`${c.label} — ${statuses[c.id] || "waiting"}`}
            >
              <img src={`/sprites-sam/${c.id}.png`} alt={c.label} />
              {active && (
                <div className="marva-typing-dots marva-sprite-dots">
                  <span>.</span><span>.</span><span>.</span>
                </div>
              )}
            </div>
          );
        })}
        {EYE_GROUPS.flatMap((g) =>
          g.eyes.map(([x, y], i) => (
            <div
              key={`eye-${g.id}-${i}`}
              className={`marva-eye ${blinking[g.id] ? "closed" : ""}`}
              style={{
                left: `${((x / PW) * 100) - 0.8}%`, top: `${((y / PH) * 100) - 2.5}%`,
                background: g.skin,
              }}
              aria-hidden="true"
            >
              <span className="marva-eye-lash" />
            </div>
          ))
        )}
        {bubbles.slice(-3).map((b, i) => (
          <div key={`${b.agentId}-${i}`} className="marva-bubble marva-sprite-bubble">
            <strong>{b.agentLabel}:</strong> {b.detail}
          </div>
        ))}
      </div>
      <div className="marva-room-bar">
        <div className="marva-room-labels-bar">
          {LAYERS.map((c) => (
            <span key={c.id} title={`${c.label} — ${statuses[c.id] || "waiting"}`}>
              <span className="marva-fur-dot" style={{ background: c.fur }} /> {c.label} <span className={`marva-dot marva-dot-${statuses[c.id] || "waiting"}`} />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
