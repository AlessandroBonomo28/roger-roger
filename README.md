# ROGER ROGER

Transfer short text between two devices using sound, with no network and no
server. One device encodes a message into audio tones and plays it through
its speaker; another device listens on its microphone and decodes the tones
back into text.

The project is themed after the Star Wars battle droids ("Roger, roger").

- demo video: https://youtube.com/shorts/1Iw6ZS17ShM

- **TRY IT**: https://rogeroger.netlify.app/

## The ROGER ROGER protocol

<img width="220" height="220" alt="success" src="https://github.com/user-attachments/assets/22608786-ec69-45dc-b929-7ec66b199183" />

This is the part that matters most: everything else in this repository exists
to drive this one audio protocol.

The message is sent using 16-tone frequency-shift keying (FSK). The idea is
that each short burst of sound at a specific pitch stands for a 4-bit value
(a nibble), so a sequence of tones can spell out any sequence of bytes.

1. **Framing.** The text is first turned into UTF-8 bytes. A single checksum
   byte is computed by XOR-ing every byte together and appended to the end, so
   the receiver can tell whether the message arrived intact.
2. **Splitting into nibbles.** Each byte (including the checksum byte) is
   split into two 4-bit nibbles, a high nibble and a low nibble. A nibble can
   only take 16 values (0 to 15), and that is exactly why 16 tones are used:
   one tone per possible nibble value.
3. **Tone assignment.** 16 frequencies are laid out 160 Hz apart, starting at
   1600 Hz (so nibble 0 is 1600 Hz, nibble 1 is 1760 Hz, and so on up to
   nibble 15 at 3999.99 Hz). Three extra frequencies above that range are
   reserved as control symbols rather than data: 4200 Hz (REPEAT), 4400 Hz
   (the ROGER sync marker), and 4800 Hz (END).
4. **Building the sequence.** The full symbol sequence is: ROGER, ROGER, then
   two symbols per byte (high nibble, low nibble) for every byte of the
   message plus the checksum byte, then END, END. The 4400 Hz opening marker
   is labelled ROGER, ROGER (fitting, since it is the app's own greeting) and
   doubling it, together with the END marker, makes both far less likely to
   be mistaken for noise or missed entirely. One important rule: the same
   frequency is never transmitted twice in a row. Whenever a nibble equals
   the previously sent one (the letter "w", 0x77, is a perfect example), the
   REPEAT symbol is sent in its place, meaning "same nibble again". Two
   identical consecutive tones would only be separated by the short silent
   gap, and room echo keeps energy alive at exactly that frequency during the
   gap, merging the two tones into one on the receiving side. A frequency
   change survives echo; a silence gap does not.
5. **Rendering to audio.** Each symbol becomes a 75 ms sine wave burst at its
   assigned frequency, with a short 5 ms fade in/out to avoid audible clicks,
   followed by a 35 ms silent gap before the next tone. Half a second of
   silence is added before and after the whole sequence, so a receiver that is
   already listening has a clear "nothing is happening yet" reference point.
6. **Decoding.** The receiver's microphone audio is split into blocks of 512
   samples (about 12 ms each). Every block is analyzed with the Goertzel
   algorithm, which measures how much energy is present at each of the 19
   candidate frequencies without computing a full spectrum, so it is cheap
   enough to run continuously in real time. If one frequency clearly dominates
   the others, that block is classified as that symbol. Several consecutive
   blocks agreeing on the same symbol are collapsed into a single tone
   (this rejects short noise spikes). A REPEAT symbol is expanded back into a
   copy of the nibble before it. Once a symbol sequence closes with END, the
   nibbles are reassembled into bytes, the trailing checksum byte is compared
   against a freshly computed XOR of the payload, and the message is accepted
   or flagged as corrupted.

The practical consequence of this design: throughput is roughly 4 characters
per second, messages are capped at 120 characters, and the two ends do not
need to be clock-synchronized in advance, because the ROGER/END markers and
the silence gaps between tones let the receiver find its own place in the
stream at any time. This also means the app is only suited to short text, not
files: at a few characters per second, anything larger would take far too
long and be far more exposed to being disrupted by background noise.

## What is a PWA

A Progressive Web App (PWA) is a website that is built and packaged so it can
behave like a regular installed app. Concretely, three things turn a normal
web page into a PWA:

* **A web app manifest** (`manifest.webmanifest`), a small JSON file that
  describes the app's name, icons, and how it should look when launched (for
  example, in its own window instead of inside a browser tab). This is what
  lets a phone or a desktop OS offer an "Install" option.
* **A service worker** (`service-worker.js`), a background script the browser
  runs on behalf of the page. It can intercept network requests and serve
  cached files, which is what allows the app to keep working without an
  internet connection after the first visit.
* **Being served over HTTPS.** Browsers only enable installability, service
  workers, and microphone access on secure origins (HTTPS, or `localhost`
  during development).

The important part for this project: a PWA is still just static files
(HTML, CSS, JavaScript, images) served by a plain web server. There is no
backend, no database, and no server-side code. Everything the app does, audio
generation, microphone capture, decoding, waveform drawing, runs entirely on
the visitor's own device, inside the browser. Nothing about the message text
or the audio ever leaves the device or reaches any server.

Because it is installable, once deployed to a hosting service the app can be
"downloaded" the same way a native app would be: opening it in a mobile
browser and choosing "Add to Home screen", or opening it on a desktop browser
and choosing "Install", puts an icon on the device that launches the app in
its own window, offline-capable, indistinguishable in daily use from a
natively installed program, while still being a web page under the hood.

## Running the PWA locally

The `pwa/` folder is the entire application: it can be opened as-is by any
static file server. A plain double-click on `pwa/index.html` (a `file://`
URL) will not work correctly, because browsers block service workers,
`AudioWorklet` modules, and microphone access on the `file://` origin. A local
HTTP server is required instead, even for local testing.

Any of the following works, run from the repository root:

```
python -m http.server 8123 --directory pwa
```

```
npx serve pwa
```

```
php -S localhost:8123 -t pwa
```

Then open `http://localhost:8123` in a browser. `localhost` counts as a
secure origin, so the microphone and the service worker both work exactly as
they would on a deployed HTTPS site.

To try the app end to end, open it on two devices (or two browser tabs/
windows) on the same machine or network, put both on the same page, type a
message and press `TRANSMIT` on one, and press `LISTEN` on the other before
or during the transmission. Keep the speaker volume reasonably high and the
two microphones/speakers physically close together.

### Deploying

Since the app is just static files, deployment is a matter of uploading the
contents of `pwa/` to any static hosting provider (for example, dragging the
`pwa` folder onto Netlify's drag-and-drop deploy area). Any provider that
serves the files over HTTPS is enough; no build step or server-side runtime is
required.

## Project layout

<img width="971" height="602" alt="Immagine 2026-07-06 213332" src="https://github.com/user-attachments/assets/d36f6cf9-502d-4fbe-bc3c-522aeaddb71d" />

* `pwa/index.html`, `pwa/styles.css`, `pwa/app.js` are the application markup,
  styling, and logic (audio protocol, decoder, waveform navigator, UI).
* `pwa/how-it-works.html` is an in-app page covering the same algorithm
  explanation as the section above, linked from the header of the main page.
* `pwa/capture-worklet.js` is the `AudioWorklet` processor that collects
  microphone samples into fixed-size blocks for the decoder.
* `pwa/manifest.webmanifest` and `pwa/service-worker.js` make the page
  installable and usable offline.
* `pwa/icons/` holds the app icons used by the manifest and by mobile home
  screens.
* `pwa/rogericon.jpg`, `pwa/success.gif`, `pwa/error.png`,
  `pwa/rogerroger.mp3` are the visual and audio assets shown for the idle,
  successful-decode, and failed-decode states. The confirmation sound plays
  whenever the success image is shown, on either tab, unless muted from the
  checkbox in the header.
* The header also links to the project's repository at
  [github.com/AlessandroBonomo28/roger-roger](https://github.com/AlessandroBonomo28/roger-roger).
