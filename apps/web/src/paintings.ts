/**
 * The paintings behind The Daily Briefing: a small set of public-domain works shipped with Attache in
 * `apps/web/public/paintings/` and served by it, never fetched at run time, so the area works offline. Each was
 * resized and compressed from the Wikimedia Commons file named in `source`, whose painter died well over 100 years
 * ago. `focal` is a CSS background position that keeps the painting's main point in view when it is cropped.
 */
export interface Painting {
  id: string;
  title: string;
  painter: string;
  year: string;
  /** Where the file was taken from: its Wikimedia Commons page. */
  source: string;
  licence: string;
  src: string;
  focal: string;
}

const painting = (p: Omit<Painting, "src">): Painting => ({ ...p, src: `/paintings/${p.id}.jpg` });

export const PAINTINGS: readonly Painting[] = [
  painting({
    id: "moonrise-over-the-sea",
    title: "Moonrise over the Sea",
    painter: "Caspar David Friedrich",
    year: "1822",
    source: "https://commons.wikimedia.org/wiki/File:Caspar_David_Friedrich_-_Mondaufgang_am_Meer_-_Google_Art_Project.jpg",
    licence: "Public domain (PD-Art, PD-old: the painter died in 1840)",
    focal: "45% 50%",
  }),
  painting({
    id: "fighting-temeraire",
    title: "The Fighting Temeraire",
    painter: "J. M. W. Turner",
    year: "1839",
    source: "https://commons.wikimedia.org/wiki/File:The_Fighting_Temeraire,_JMW_Turner,_National_Gallery.jpg",
    licence: "Public domain (PD-Art, PD-old: the painter died in 1851)",
    focal: "30% 55%",
  }),
  painting({
    id: "hay-wain",
    title: "The Hay Wain",
    painter: "John Constable",
    year: "1821",
    source: "https://commons.wikimedia.org/wiki/File:John_Constable_-_The_Hay_Wain_(1821).jpg",
    licence: "Public domain (PD-Art, PD-old: the painter died in 1837)",
    focal: "62% 72%",
  }),
  painting({
    id: "among-the-sierra-nevada",
    title: "Among the Sierra Nevada, California",
    painter: "Albert Bierstadt",
    year: "1868",
    source: "https://commons.wikimedia.org/wiki/File:Albert_Bierstadt_-_Among_the_Sierra_Nevada,_California_-_Google_Art_Project.jpg",
    licence: "Public domain (PD-Art, PD-old-100: the painter died in 1902)",
    focal: "42% 60%",
  }),
  painting({
    id: "windmill-at-wijk-bij-duurstede",
    title: "The Windmill at Wijk bij Duurstede",
    painter: "Jacob van Ruisdael",
    year: "1668-1670",
    source: "https://commons.wikimedia.org/wiki/File:De_molen_bij_Wijk_bij_Duurstede_Rijksmuseum_SK-C-211.jpeg",
    licence: "Public domain (PD-old: the painter died in 1682; photograph CC0 by the Rijksmuseum)",
    focal: "68% 45%",
  }),
  painting({
    id: "nocturne-blue-and-silver-chelsea",
    title: "Nocturne: Blue and Silver - Chelsea",
    painter: "James McNeill Whistler",
    year: "1871",
    source: "https://commons.wikimedia.org/wiki/File:James_Abbott_McNeill_Whistler_-_Nocturne-_Blue_and_Silver_-_Chelsea_-_Google_Art_Project.jpg",
    licence: "Public domain (PD-Art, PD-old-100: the painter died in 1903)",
    focal: "70% 60%",
  }),
  painting({
    id: "souvenir-de-mortefontaine",
    title: "Recollection of Mortefontaine",
    painter: "Camille Corot",
    year: "1864",
    source: "https://commons.wikimedia.org/wiki/File:Souvenir_de_Mortefontaine_(Camille_Corot).jpg",
    licence: "Public domain (PD-Art, PD-old-100: the painter died in 1875)",
    focal: "28% 72%",
  }),
];

const DAY_MS = 86_400_000;

/**
 * The painting for a briefing's day ("2026-11-20"): the same on every browser and Machine that day, and the next one
 * in the set the day after, so the set comes round once every few days.
 */
export function paintingForDate(date: string): Painting {
  const days = Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
  return PAINTINGS[((days % PAINTINGS.length) + PAINTINGS.length) % PAINTINGS.length]!;
}
