import { createFileRoute } from '@tanstack/react-router';
import App from '../lab/App';
export const Route = createFileRoute('/')({
  head: () => ({links:[{rel:'canonical',href:'https://helix-dna-lab.higgsfield.app/'}]}),
  component: App,
});
