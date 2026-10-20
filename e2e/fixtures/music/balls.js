export function draw(canvas, n) {
  const g = canvas.getContext("2d");
  for (let i = 0; i < n; i++) {
    g.fillStyle = `hsl(${i * 30}, 60%, 55%)`;
    g.beginPath();
    g.arc(25 + i * 48, 80 + 50 * Math.sin(i), 14, 0, 2 * Math.PI);
    g.fill();
  }
}
