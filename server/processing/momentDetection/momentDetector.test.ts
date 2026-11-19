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

