# BiLSTM COVID-19 Tweet Classifier

A sequence model that classifies COVID-19 tweets into five categories — misinformation, confirmed case reports, official guidance, personal experience, and news — trained on a 100k-tweet corpus.

---

## Motivation

During the pandemic, Twitter became a primary information channel — and a major misinformation vector. Automated classification of tweet intent (not just sentiment) could help surface reliable content and flag potential misinformation pipelines at scale.

## Model Design

A bidirectional LSTM reads the token sequence left-to-right and right-to-left simultaneously, letting the final hidden state encode full sentence context before classification.

```
Tweet ──► Tokenizer ──► Embedding (128d) ──► BiLSTM (256 hidden × 2 dirs) ──► FC ──► 5 classes
```

**Architecture details:**
- Vocabulary: 28,400 tokens (frequency-filtered, custom tokenizer)
- Embedding: 128-dimensional learned embeddings
- BiLSTM: 2 layers, 256 hidden units per direction, dropout 0.4
- Classifier head: Linear(512 → 128) → ReLU → Dropout(0.3) → Linear(128 → 5)
- Total parameters: **851,244**

## Training

| Setting | Value |
|---------|-------|
| Optimizer | Adam, lr=3e-4 |
| Batch size | 128 |
| Epochs | 22 (early stopping, patience=4) |
| Loss | CrossEntropyLoss with class weights |
| Hardware | NVIDIA RTX 3060 (local) |

Class imbalance was handled with inverse-frequency weighting — the misinformation class was underrepresented (~8% of samples) and benefited most from this.

## Data Pipeline

1. **Collection** — 100k tweets from the COVID-Twitter dataset, filtered to English
2. **Cleaning** — URL removal, @ normalization, hashtag splitting, lowercase
3. **Tokenization** — custom word-level tokenizer (no BPE), max length 64
4. **Split** — 80 / 10 / 10 train / val / test, stratified by class

## Results

| Class | Precision | Recall | F1 |
|-------|-----------|--------|----|
| Official guidance | 0.84 | 0.89 | 0.86 |
| News | 0.79 | 0.81 | 0.80 |
| Personal experience | 0.73 | 0.70 | 0.71 |
| Case report | 0.77 | 0.74 | 0.75 |
| Misinformation | 0.68 | 0.63 | 0.65 |
| **Overall** | | | **0.76 (macro)** |

**Test accuracy: 76.8%**

The misinformation class had the lowest recall — expected given its semantic overlap with personal experience tweets and the noisier labelling in the source dataset.

## What I'd Do Differently

- Fine-tune a pretrained transformer (BERTweet or RoBERTa-Twitter) rather than training embeddings from scratch. The custom tokenizer loses a lot of subword signal.
- Add a confidence threshold so low-confidence predictions are routed to human review rather than hard-classified.
- Experiment with focal loss instead of weighted CE for the long-tail classes.

## Stack

Python · PyTorch · NumPy · scikit-learn · Matplotlib · Jupyter
