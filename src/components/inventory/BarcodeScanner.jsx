import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";

// Phone-camera barcode scanning.
//
// Uses the browser's own BarcodeDetector — no library, no download. Android
// Chrome has it built in; desktop Chrome and Edge have it too. Safari on iPhone
// does NOT, and there is no way to feature-detect around that, so the caller is
// told plainly and falls back to the Bluetooth scanner or typing the number.
//
// The camera also needs a secure page (https, or localhost). On a site served
// over plain http on the LAN the browser blocks getUserMedia outright and
// reports it as a permission failure, which reads like the user did something
// wrong — so we check for it up front and say what is actually wrong.

/** True when this browser can read barcodes from a camera frame. */
export function isCameraScanSupported() {
  return typeof window !== "undefined" && typeof window.BarcodeDetector === "function";
}

/** True when the page is served from a context the camera is allowed in. */
export function isSecurePage() {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

/**
 * Why the camera is unavailable, in words an operator can act on, or null when
 * it is available.
 */
export function cameraUnavailableReason() {
  if (typeof window === "undefined") return null;
  if (!isSecurePage()) {
    return "The camera is blocked because this page is not on a secure (https) address. Use the Bluetooth scanner or type the barcode, and ask for TLS to be switched on for this site.";
  }
  if (!isCameraScanSupported()) {
    return "This browser cannot read barcodes from the camera. iPhones are the usual case. Use the Bluetooth scanner or type the barcode — both work here.";
  }
  return null;
}

// The symbologies that actually appear on the stock: retail EAN/UPC on almost
// everything, Code 128 and Code 39 on supplier and internal labels, ITF-14 on
// outer cases.
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf"];

/**
 * A full-screen camera view that reports the first barcode it reads and closes.
 *
 * One shot rather than continuous: the operator maps the item before scanning
 * the next one, and a camera left running behind a form drains the phone.
 *
 * @param {{ onDetect: (code: string) => void, onClose: () => void }} props
 */
export default function BarcodeScanner({ onDetect, onClose }) {
  const videoRef = useRef(/** @type {HTMLVideoElement | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let stream = /** @type {MediaStream | null} */ (null);
    let timer = /** @type {ReturnType<typeof setInterval> | null} */ (null);
    let stopped = false;

    async function start() {
      const blocked = cameraUnavailableReason();
      if (blocked) {
        setError(blocked);
        setStarting(false);
        return;
      }
      try {
        // The rear camera: "environment" is what a phone points at a shelf.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setStarting(false);

        const detector = new window.BarcodeDetector({ formats: FORMATS });
        // ~7 reads a second is plenty and leaves the phone responsive.
        timer = setInterval(async () => {
          if (stopped || !videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const found = await detector.detect(videoRef.current);
            const code = found?.[0]?.rawValue;
            if (code) {
              stopped = true;
              if (navigator.vibrate) navigator.vibrate(60);
              onDetect(String(code));
            }
          } catch {
            // A single dropped frame is normal while the camera focuses; the
            // next tick tries again. Only a failure to START is worth showing.
          }
        }, 140);
      } catch (err) {
        const name = /** @type {any} */ (err)?.name;
        setStarting(false);
        if (name === "NotAllowedError") {
          setError("Camera access was refused. Allow the camera for this site in the browser's address-bar menu, then try again.");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setError("No camera was found on this device. Use the Bluetooth scanner or type the barcode.");
        } else {
          setError(`The camera could not be started: ${/** @type {any} */ (err)?.message || String(err)}`);
        }
      }
    }

    start();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [onDetect]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Camera className="h-4 w-4" /> Point at the barcode
        </span>
        <button onClick={onClose} className="rounded-full p-2 hover:bg-white/10" aria-label="Close the camera">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {/* A window to aim through. Purely a sighting aid — the detector reads
            the whole frame, so a barcode slightly outside it still scans. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-32 w-4/5 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
        </div>
        {starting && !error && (
          <div className="absolute inset-x-0 bottom-10 text-center text-sm text-white/80">Starting the camera…</div>
        )}
      </div>

      {error && (
        <div className="bg-red-950 px-4 py-4 text-sm text-red-100">
          {error}
          <button onClick={onClose} className="mt-3 block w-full rounded-md bg-white/10 py-2 font-medium text-white">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
