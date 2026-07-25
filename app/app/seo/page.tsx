"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, Plus, TrendingUp, AlertCircle, Wand2, ShieldAlert } from "lucide-react";
import { useCompetitorList } from "@/hooks/useCompetitorList";
import { fetchSeoKeywords, createSeoKeyword, generateKeywordGapReport } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import type { TrackedKeyword } from "@/types";

export default function SeoKeywordsPage() {
  const { competitors, loading: compsLoading } = useCompetitorList();
  const [keywords, setKeywords] = useState<TrackedKeyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyword, setNewKeyword] = useState("");
  const [adding, setAdding] = useState(false);

  const [generatingGap, setGeneratingGap] = useState(false);
  const [gapReport, setGapReport] = useState<any>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchSeoKeywords();
      setKeywords(data);
    } catch {
      setKeywords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAddKeyword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyword.trim()) return;
    setAdding(true);
    try {
      await createSeoKeyword(newKeyword.trim());
      setNewKeyword("");
      load();
      toast({ title: "Keyword added", description: "Successfully tracking new keyword." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  const handleGenerateGapReport = async () => {
    setGeneratingGap(true);
    try {
      const report = await generateKeywordGapReport();
      setGapReport(report);
      toast({ title: "Report generated", description: "Keyword gap analysis complete." });
    } catch (err: any) {
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
    } finally {
      setGeneratingGap(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Keyword & SEO Monitoring"
        description="Track your workspace keywords and discover content gaps against competitors."
        actions={
          <Button onClick={handleGenerateGapReport} disabled={generatingGap}>
            {generatingGap ? (
              <span className="flex items-center"><Search className="mr-2 h-4 w-4 animate-spin" /> Analyzing...</span>
            ) : (
              <span className="flex items-center"><Wand2 className="mr-2 h-4 w-4" /> Run Gap Analysis</span>
            )}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Tracked Keywords List */}
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Tracked Keywords</CardTitle>
            <CardDescription>Keywords tracked globally for this workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAddKeyword} className="flex gap-2 mb-4">
              <Input 
                placeholder="Add keyword..." 
                value={newKeyword}
                onChange={e => setNewKeyword(e.target.value)}
                disabled={adding}
              />
              <Button type="submit" disabled={adding || !newKeyword.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </form>

            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : keywords.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground border border-dashed rounded-md">
                No keywords tracked yet.
              </div>
            ) : (
              <div className="space-y-2">
                {keywords.map(kw => (
                  <div key={kw.id} className="flex items-center justify-between p-2 rounded-md border bg-card">
                    <span className="font-medium">{kw.keyword}</span>
                    <Badge variant="secondary">Tracked</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Gap Report Results */}
        <Card className="col-span-1 lg:col-span-2">
          <CardHeader>
            <CardTitle>Keyword Gap Analysis</CardTitle>
            <CardDescription>
              {gapReport ? `Analyzed ${gapReport.totalKeywordsAnalyzed} keywords across ${gapReport.competitors?.length} competitors.` : "Run an analysis to see how your domain compares to competitors."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!gapReport && !generatingGap && (
              <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground border border-dashed rounded-md">
                <Search className="h-8 w-8 mb-4 text-muted-foreground/50" />
                <p>No gap report generated yet.</p>
                <Button variant="link" onClick={handleGenerateGapReport}>Run analysis now</Button>
              </div>
            )}

            {generatingGap && (
              <div className="flex flex-col items-center justify-center py-12 space-y-4 border border-dashed rounded-md">
                <Search className="h-8 w-8 animate-spin text-primary" />
                <p className="text-muted-foreground">Scraping SERPs and computing gaps...</p>
              </div>
            )}

            {gapReport && !generatingGap && (
              <div className="space-y-6">
                
                {gapReport.gaps?.length > 0 && (
                  <div className="space-y-3">
                    <h3 className="text-lg font-semibold flex items-center text-red-500">
                      <ShieldAlert className="mr-2 h-5 w-5" /> True Content Gaps
                    </h3>
                    <p className="text-sm text-muted-foreground mb-2">Keywords where competitors rank in the top 20, but your domain does not.</p>
                    <div className="grid gap-3">
                      {gapReport.gaps.map((gap: any, i: number) => (
                        <div key={i} className="p-3 border border-red-500/20 bg-red-500/5 rounded-lg flex items-center justify-between">
                          <div>
                            <span className="font-semibold">{gap.keyword}</span>
                            <div className="text-xs text-muted-foreground mt-1">{gap.recommendation}</div>
                          </div>
                          <Badge variant="destructive">Avg Rank: {gap.avgRank}</Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-8 overflow-auto border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Keyword</TableHead>
                        <TableHead>Your Rank</TableHead>
                        {gapReport.competitors?.map((c: any) => (
                          <TableHead key={c.id}>{c.name}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {gapReport.matrix?.map((row: any, i: number) => (
                        <TableRow key={i}>
                          <TableCell className="font-medium">{row.keyword}</TableCell>
                          <TableCell>
                            {row.userRank ? <Badge variant={row.userRank <= 10 ? "default" : "secondary"}>#{row.userRank}</Badge> : <span className="text-muted-foreground">-</span>}
                          </TableCell>
                          {gapReport.competitors?.map((c: any) => (
                            <TableCell key={c.id}>
                              {row.rankings[c.id] ? <Badge variant="outline">#{row.rankings[c.id]}</Badge> : <span className="text-muted-foreground">-</span>}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
