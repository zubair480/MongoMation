import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/client/components/ui/Card';
import { Button } from '@/client/components/ui/Button';
import Page from '@/client/components/Page';

export default function NotFoundPage() {
  return (
    <Page seo={{ title: 'Page not found', noindex: true }}>
      <div className="flex flex-1 items-center justify-center py-10">
        <Card className="w-full max-w-sm mx-auto">
          <CardHeader className="text-center">
            <CardTitle className="text-6xl font-bold">404</CardTitle>
          </CardHeader>
          
          <CardContent className="flex flex-col items-center gap-8">
            <p className="text-plant-300 text-center">
              Page not found
            </p>
            <Link to="/" className="w-full">
              <Button className="w-full">
                Go home
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

