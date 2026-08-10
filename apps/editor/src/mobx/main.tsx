import { createRoot } from "react-dom/client";

import "../styles.css";
import { MobxExperiment } from "./MobxExperiment";

const root = document.getElementById("mobx-root");
if (!root) {
  throw new Error("MobX experiment root element is missing.");
}

createRoot(root).render(<MobxExperiment />);
