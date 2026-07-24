# AGENTS.md - Shoots

Questo file e' il contesto operativo rapido per agenti AI che lavorano su Shoots. Leggilo prima di modificare codice.

## Regole tecniche da preservare

- Verifica sempre il flusso end-to-end
- OGNI SOFTWARE ESTERNO DEVE POTER ESSERE COMMERCIALIZZATO. Ogni dipendenza runtime,
  binario di terze parti o modello adottato deve avere una licenza che consenta l'uso e la
  redistribuzione commerciale (es. MIT, BSD, Apache-2.0, Artistic/GPL per binari eseguiti
  come processo esterno). Verificare la licenza PRIMA di introdurre una nuova dipendenza;
  in caso di dubbio, scartarla o cercare un'alternativa.

## Convenzioni di lavoro

- Best Practice deve essere un mantra: evitare file monolitici, separare componenti UI, servizi wiring e logiche riusabili in moduli/cartelle dedicati.
- Nei renderer React, preferire componenti separati e hook/servizi riusabili invece di accumulare JSX/TSX, state management e utility nello stesso file.
- Aggiungere commenti in inglese solo dove aiutano a chiarire logica non ovvia.
- NON CREARE MAI NUOVI BRANCH
- Per modifiche dentro repo git, eseguire `git add` e `git commit` con messaggio coerente.
- I commit devono seguire sempre la semantic release.
- Never include your signature in commits or commit descriptions.
- usa sempre e solamente testi in inglese per la UI
- use sempre e solamente testi in inglese nei commenti del codice
