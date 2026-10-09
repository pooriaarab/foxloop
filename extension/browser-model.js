// The in-browser model, in its own file. background.js loads it only when
// the user picks it, and web-ext lint skips it with ort/: transformers.js
// and ONNX Runtime evaluate strings, and the rest of the demo does not.
export { transformers } from "foxmind/browser";
