import { createFileRoute } from '@tanstack/react-router';
import { handleLab } from '../../lib/lab.server';
export const Route = createFileRoute('/api/$')({server:{handlers:{
  GET:({request}) => handleLab(request),
  POST:({request}) => handleLab(request),
  PATCH:({request}) => handleLab(request),
}}});
