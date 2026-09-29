// The preview pane's dependencies, gathered onto one global (window.Vendor)
// so index.html can load it as a classic script and open straight from file://.
// The editor itself uses no libraries. Rebuild with ./vendor/build.sh.
import { marked } from "marked";
import DOMPurify from "dompurify";

window.Vendor = { marked, DOMPurify };
