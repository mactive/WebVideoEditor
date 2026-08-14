import { createRoot } from "react-dom/client";

import { OpfsExplorer } from "./OpfsExplorer";
import "./OpfsExplorer.css";

const root = document.getElementById("opfs-root");

if (!root) {
  throw new Error("OPFS explorer root element is missing.");
}

createRoot(root).render(<OpfsExplorer />);
