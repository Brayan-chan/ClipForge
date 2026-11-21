import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SCORING_CONFIG } from '../../db';
import type { TranscriptSegment } from '../../../src/types';
import { detectNarrativeMoments } from './momentDetector';

const noAudio = { energyPeaks: [] as number[], silenceEnds: [] as number[], available: false };

function segment(id: number, start: number, end: number, text: string): TranscriptSegment {
  return { id: `s-${id}`, start, end, text };
}

test('returns zero clips for ordinary chatter without an event', () => {
  const segments = [
    segment(1, 0, 4, 'Bueno, hoy estamos aquí hablando un poco del horario.'),
    segment(2, 4.2, 8, 'Luego seguramente seguiremos con otras cosas.'),
    segment(3, 8.2, 13, 'También tengo que ordenar el escritorio esta tarde.'),
    segment(4, 13.3, 18, 'Y después veremos qué hacemos durante el directo.'),
  ];
  const result = detectNarrativeMoments({
    segments,
    config: DEFAULT_SCORING_CONFIG,
    sceneTimestamps: [],
    audio: noAudio,
  });
  assert.equal(result.length, 0);
});

test('builds a complete setup, reveal and reaction event', () => {
  const segments = [
    segment(1, 0, 3, 'Vamos a abrir la caja porque nadie sabe qué contiene.'),
    segment(2, 3.1, 6, 'Atentos todos, en tres, dos, uno.'),
    segment(3, 6.1, 9, 'Ahí está. ¡No me lo puedo creer, madre mía!'),
    segment(4, 9.1, 12, 'Es increíble, tiene todos los detalles que esperaba.'),
    segment(5, 12.8, 16, 'Al final ha valido completamente la pena.'),
  ];
  const result = detectNarrativeMoments({
    segments,
    config: DEFAULT_SCORING_CONFIG,
    sceneTimestamps: [6.2],
    audio: { energyPeaks: [7], silenceEnds: [12.2], available: true },
  });
  assert.ok(result.length >= 1);
  assert.ok(result[0].startTime <= 3.1);
  assert.ok(result[0].endTime >= 12);
  assert.ok(result[0].score >= 70);
});

test('does not end while the final thought is grammatically open', () => {
  const segments = [
    segment(1, 0, 3, 'Voy a intentar este salto imposible.'),
    segment(2, 3.1, 6, 'Atentos porque ahora viene lo difícil.'),
    segment(3, 6.1, 9, '¡No puede ser, se ha caído!'),
    segment(4, 9.1, 12, 'Pero espera porque todavía'),
    segment(5, 12.1, 15, 'puede levantarse y terminar la carrera.'),
    segment(6, 15.8, 18, 'Al final lo consiguió.'),
  ];
  const result = detectNarrativeMoments({
    segments,
    config: DEFAULT_SCORING_CONFIG,
    sceneTimestamps: [],
    audio: { energyPeaks: [7], silenceEnds: [15.2], available: true },
  });
  assert.ok(result.length >= 1);
  assert.ok(result[0].endTime >= 15);
  assert.ok(!result[0].transcriptExcerpt.endsWith('todavía'));
});

test('honors the requested clip limit and never exceeds ten', () => {
  const segments = Array.from({ length: 30 }, (_, index) => {
    const start = index * 4;
    const texts = [
      'Voy a intentar este salto imposible, atentos.',
      '¡No puede ser, casi se ha caído!',
      'Pero al final lo consiguió y esa es la razón.',
    ];
    return segment(index + 1, start, start + 3.5, texts[index % texts.length]);
  });
  const five = detectNarrativeMoments({
    segments,
    config: DEFAULT_SCORING_CONFIG,
    sceneTimestamps: [5, 29, 53, 77, 101],
    audio: { energyPeaks: [5, 29, 53, 77, 101], silenceEnds: [], available: true },
    maxClips: 5,
  });
  const clamped = detectNarrativeMoments({
    segments,
    config: DEFAULT_SCORING_CONFIG,
    sceneTimestamps: [5, 29, 53, 77, 101],
    audio: { energyPeaks: [5, 29, 53, 77, 101], silenceEnds: [], available: true },
    maxClips: 99,
  });
  assert.ok(five.length <= 5);
  assert.ok(clamped.length <= 10);
});

test('can rank a strong opinion without requiring a loud reaction keyword', () => {
  const segments = [
    segment(1, 0, 4, 'Para mí, este es el peor sistema para aprender a conducir.'),
    segment(2, 4.1, 8, 'El problema es que castiga justo cuando intentas mejorar.'),
    segment(3, 8.1, 12, 'Pero resulta que cambiar una sola regla transforma la carrera.'),
    segment(4, 12.1, 16, 'Al final funciona mejor y esa es la razón.'),
  ];
  const result = detectNarrativeMoments({
    segments,
    config: DEFAULT_SCORING_CONFIG,
    sceneTimestamps: [],
    audio: noAudio,
    maxClips: 5,
  });
  assert.ok(result.length >= 1);
  assert.ok(['Opinión', 'Conflicto'].includes(result[0].hookType));
});

test('uses audiovisual change as the event and recovers context before a restrained reaction', () => {
  const segments = [
    segment(1, 0, 4, 'Estoy entrando a la siguiente zona y voy a probar otra ruta.'),
    segment(2, 4.1, 8, 'Tengo que mantener el coche dentro de esta parte del circuito.'),
    segment(3, 8.1, 12, 'Ahora viene la curva que estaba preparando desde antes.'),
    segment(4, 12.1, 16, 'Ha ocurrido justo aquí.'),
    segment(5, 16.1, 20, 'Vale, ya entiendo lo que cambió y podemos continuar.'),
  ];
  const result = detectNarrativeMoments({
    segments,
    config: DEFAULT_SCORING_CONFIG,
    sceneTimestamps: [13],
    audio: { energyPeaks: [13.2], silenceEnds: [], available: true },
    maxClips: 5,
  });
  assert.ok(result.length >= 1);
  assert.ok(result[0].startTime <= 4.1, `expected context before event, got ${result[0].startTime}`);
  assert.ok(result[0].endTime >= 20);
  assert.match(result[0].reason, /visual change|energy peak/);
});

test('does not claim heuristic certainty or award 100 to generated clips', () => {
  const segments = [
    'Os voy a enseñar algo que no esperaba nadie.',
    'Mira cómo cambia todo justo en este momento.',
    'No puede ser, esto es increíble.',
    'Al final conseguimos terminarlo y salió bien.',
  ].map((text, index) => segment(index + 1, index * 4, index * 4 + 3.5, text));
  const clips = detectNarrativeMoments({
    segments,
    config: DEFAULT_SCORING_CONFIG,
    sceneTimestamps: [4, 8, 12],
    audio: { available: true, energyPeaks: [8, 10], silenceEnds: [15] },
    maxClips: 5,
  });
  assert.ok(clips.length > 0);
  assert.ok(clips.every((clip) => clip.score <= 96));
});

