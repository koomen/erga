let n = 0;
const count = document.getElementById("count");
document.getElementById("bump").addEventListener("click", () => { count.textContent = String(++n); });
