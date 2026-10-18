/**
 * Hand-curated starting catalog (PRD §14: "curated seed catalog" for the first release).
 * Shows are Apple Podcasts ids; episodes are pulled from Apple by the catalog refresh job.
 * Edit this list to change what Discover shows; run the refresh to pick up changes.
 */

export const TOPICS = [
  {
    id: 'decisions',
    name: 'Decision-making',
    blurb: 'Judgement, risk and choosing well when you can’t know for sure.',
  },
  {
    id: 'psychology',
    name: 'Psychology',
    blurb: 'Why we do what we do, and how to work with your own mind.',
  },
  { id: 'health', name: 'Health', blurb: 'Sleep, training, nutrition and longevity, from the evidence.' },
  { id: 'money', name: 'Money', blurb: 'Investing and personal finance without the noise.' },
  { id: 'business', name: 'Business', blurb: 'Founders, operators and how great companies get built.' },
  { id: 'tech', name: 'AI & Tech', blurb: 'What new technology can really do, and what it means.' },
  { id: 'science', name: 'Science', blurb: 'Curious, rigorous stories about how the world works.' },
  { id: 'productivity', name: 'Focus', blurb: 'Deep work, attention and building a life that works.' },
  { id: 'creativity', name: 'Creativity', blurb: 'Design, music, writing and the craft behind them.' },
] as const;

export type TopicId = (typeof TOPICS)[number]['id'];

export const CURATED_SHOWS: Array<{ sourceShowId: string; topic: TopicId; title: string }> = [
  { sourceShowId: '990149481', topic: 'decisions', title: 'The Knowledge Project' },
  { sourceShowId: '354668519', topic: 'decisions', title: 'Freakonomics Radio' },
  { sourceShowId: '1337886873', topic: 'decisions', title: 'Choiceology with Katy Milkman' },
  { sourceShowId: '1028908750', topic: 'psychology', title: 'Hidden Brain' },
  { sourceShowId: '521594713', topic: 'psychology', title: 'You Are Not So Smart' },
  { sourceShowId: '942777522', topic: 'psychology', title: 'Human Potential Lab' },
  { sourceShowId: '1545953110', topic: 'health', title: 'Huberman Lab' },
  { sourceShowId: '1400828889', topic: 'health', title: 'The Peter Attia Drive' },
  { sourceShowId: '1333552422', topic: 'health', title: 'Feel Better, Live More with Dr Rangan Chatterjee' },
  { sourceShowId: '1611216298', topic: 'health', title: 'ZOE Science & Nutrition' },
  { sourceShowId: '290783428', topic: 'money', title: 'Planet Money' },
  {
    sourceShowId: '928933489',
    topic: 'money',
    title: "The Investor's Podcast (We Study Billionaires)  - The Investor’s Podcast Network",
  },
  { sourceShowId: '6807925823', topic: 'money', title: 'Invest Like The Best' },
  { sourceShowId: '1079598542', topic: 'money', title: 'Afford Anything | Get Smarter With Money' },
  { sourceShowId: '1150510297', topic: 'business', title: 'How I Built This with Guy Raz' },
  { sourceShowId: '1050462261', topic: 'business', title: 'Acquired' },
  { sourceShowId: '1627920305', topic: 'business', title: "Lenny's Podcast: Product | Career | Growth" },
  { sourceShowId: '1227971746', topic: 'business', title: 'Masters of Scale' },
  { sourceShowId: '1346314086', topic: 'business', title: 'Worklife with Molly Graham' },
  { sourceShowId: '1528594034', topic: 'tech', title: 'Hard Fork' },
  { sourceShowId: '1516093381', topic: 'tech', title: 'Dwarkesh Podcast' },
  { sourceShowId: '1434243584', topic: 'tech', title: 'Lex Fridman Podcast' },
  { sourceShowId: '152249110', topic: 'science', title: 'Radiolab' },
  { sourceShowId: '1051557000', topic: 'science', title: 'Science Vs' },
  { sourceShowId: '1278815517', topic: 'science', title: 'Ologies with Alie Ward' },
  { sourceShowId: '1515786216', topic: 'productivity', title: 'Deep Questions with Cal Newport' },
  { sourceShowId: '863897795', topic: 'productivity', title: 'The Tim Ferriss Show' },
  { sourceShowId: '582272991', topic: 'productivity', title: 'The Rich Roll Podcast' },
  { sourceShowId: '328074695', topic: 'creativity', title: 'Design Matters with Debbie Millman' },
  { sourceShowId: '788236947', topic: 'creativity', title: 'Song Exploder' },
  { sourceShowId: '990871441', topic: 'creativity', title: 'Writing Excuses' },
];
