import type { Op } from '../core/model';

export const OP_LABEL: Record<Op['t'], string> = {
  stroke: 'Stroke', smudge: 'Smudge', effect: 'Effect', shape: 'Shape', fill: 'Fill', fillPoly: 'Lasso fill', transform: 'Move', tiles: 'Pixels restored',
  'layer.add': 'Layer added', 'layer.remove': 'Layer deleted', 'layer.clear': 'Layer cleared', 'layer.props': 'Layer settings', 'layer.merge': 'Merged down',
  'layer.mask.apply': 'Mask applied', 'folder.add': 'Folder added', 'folder.remove': 'Folder deleted', 'folder.props': 'Folder settings', 'node.move': 'Reordered',
};
