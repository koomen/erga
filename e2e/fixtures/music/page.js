import { draw } from "./balls.js";

// The widget's sound, as a Blob it plays from (as a page that edits or slices its audio does).
const res = await fetch("audio.m4a");
const url = URL.createObjectURL(await res.blob());
const player = new Audio(url);
player.preload = "auto";
draw(document.getElementById("balls"), 12);
