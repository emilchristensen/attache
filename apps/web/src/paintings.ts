export interface Painting {
  id: string;
  title: string;
  painter: string;
  src: string;
  focal: string;
}

export const PAINTINGS: readonly Painting[] = [
  { id: "coast", title: "A View of the Sea", painter: "Public domain", src: "/paintings/coast.svg", focal: "50% 45%" },
  { id: "field", title: "Summer Fields", painter: "Public domain", src: "/paintings/field.svg", focal: "50% 50%" },
  { id: "garden", title: "The Garden Wall", painter: "Public domain", src: "/paintings/garden.svg", focal: "45% 40%" },
];

export function paintingForDate(date: string): Painting {
  const day = Number(date.replace(/-/g, ""));
  return PAINTINGS[Math.abs(day) % PAINTINGS.length]!;
}
