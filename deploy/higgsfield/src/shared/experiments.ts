import type { ExperimentDefinition } from "./types";

// GRCh38/hg38, chr9:128225974-128226014, 1-based inclusive, forward strand.
// UCSC and Ensembl independently returned this 41-base reference window.
// Index 20 is chr9:128225994 G. Only its G>A edit has a published replay here.
export const DEFAULT_EXPERIMENT: ExperimentDefinition = {
  id: "dnm1-splice-replay",
  gene: "DNM1",
  title: "One letter changes RNA splicing",
  tissue: "Glutamatergic neuron · published prediction",
  referenceSequence: "CACTTCTCCTCCCCACCCACGGCTGCTCCTCCTCCTGTCCC",
  sequenceKind: "reference",
  locus: {
    assembly: "GRCh38",
    chromosome: "chr9",
    start: 128225974,
    strand: "+",
  },
  defaultIndex: 20,
  alternate: "A",
  summary:
    "Replay a published DNM1 case in which one DNA letter changes how a brain-specific RNA transcript is assembled.",
  mechanism:
    "The reported G → A change creates an alternative splice acceptor before exon 10a. An extra 39 RNA bases remain, adding 13 amino acids to the protein.",
  evidence:
    "The Atlas study compared reference and alternate predictions and reported minigene experiments supporting the altered splicing. Its neuron prediction showed the brain-specific exon; the blood prediction barely expressed it.",
  limitation:
    "This is a schematic replay of published findings, not a live AlphaGenome prediction. Other edits are unscored. The animation does not predict a person’s symptoms or show measured molecular motion.",
  sources: [
    {
      title: "AlphaGenome Atlas paper · Figure 3 and Table S4",
      url: "https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/alphagenome-atlas.pdf",
    },
    {
      title: "Google DeepMind · DNM1 research summary",
      url: "https://deepmind.google/blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/",
    },
    {
      title: "UCSC · verified hg38 reference sequence",
      url: "https://api.genome.ucsc.edu/getData/sequence?genome=hg38;chrom=chr9;start=128225973;end=128226014",
    },
    {
      title: "Ensembl · independent GRCh38 sequence check",
      url: "https://rest.ensembl.org/sequence/region/human/9:128225974..128226014:1?content-type=application/json",
    },
  ],
};

export const EXPERIMENTS: ExperimentDefinition[] = [DEFAULT_EXPERIMENT];
