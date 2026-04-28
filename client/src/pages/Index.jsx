import { useState, useEffect, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Loader2, FileSearch, AlertCircle, Upload, FileText, X, ChevronLeft, ExternalLink, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import Mark from "mark.js";
import JSZip from "jszip";

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

// CSS for PDF Text Layer
const TEXT_LAYER_CSS = `
.textLayer {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
  opacity: 1;
  line-height: 1.0;
  pointer-events: auto;
  z-index: 2;
}
.textLayer span {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.textLayer span::selection {
  background: rgba(0, 115, 255, 0.2);
  color: transparent;
}
.textLayer .mark-highlight {
  color: transparent;
  pointer-events: auto;
}
`;

const PdfPage = ({ page, results, scale = 1.2, activeFindingIdx, onFindingClick, docHighlightsRefs }) => {
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const markInstanceRef = useRef(null);
  const [viewport, setViewport] = useState(null);

  useEffect(() => {
    const renderPage = async () => {
      const p = await page;
      const vp = p.getViewport({ scale });
      setViewport(vp);
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      canvas.height = vp.height;
      canvas.width = vp.width;

      await p.render({ canvasContext: context, viewport: vp }).promise;

      // Render Text Layer
      const textContent = await p.getTextContent();
      const textLayer = textLayerRef.current;
      textLayer.innerHTML = "";
      const textDivs = [];
      await pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport: vp,
        textDivs: textDivs
      }).promise;

      // Calculate Highlights by matching textContent and applying classes to textDivs
      if (results && textDivs.length === textContent.items.length) {
        let currentFindingCounter = 0;

        results.forEach(resultItem => {
          if (resultItem.similarity >= 40) {
            const findingIdx = currentFindingCounter++;
            const sentenceToFindRaw = resultItem.sentence.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (sentenceToFindRaw.length < 5) return;

            let fullText = "";
            const itemMap = [];
            
            textContent.items.forEach((item, idx) => {
              if (!item.str) return;
              const str = item.str.toLowerCase().replace(/[^a-z0-9]/g, '');
              for (let i = 0; i < str.length; i++) {
                itemMap.push(idx);
              }
              fullText += str;
            });

            const startIndex = fullText.indexOf(sentenceToFindRaw);
            if (startIndex !== -1) {
              const endIndex = startIndex + sentenceToFindRaw.length - 1;
              const itemsToHighlight = new Set();
              for (let i = startIndex; i <= endIndex; i++) {
                itemsToHighlight.add(itemMap[i]);
              }

              let colorClass = "bg-yellow-300/50 border-b-2 border-yellow-500";
              if (resultItem.similarity > 50) colorClass = "bg-red-300/60 border-b-2 border-red-500";
              else if (resultItem.similarity > 25) colorClass = "bg-orange-300/60 border-b-2 border-orange-500";

              itemsToHighlight.forEach(idx => {
                const span = textDivs[idx];
                if (span) {
                  // Keep text transparent, but add background and pointer events
                  span.className = `${span.className || ''} mark-highlight cursor-pointer transition-all duration-300 ${colorClass}`.trim();
                  span.setAttribute("data-finding-idx", findingIdx);
                  span.onclick = () => onFindingClick && onFindingClick(findingIdx);
                  
                  // Save ref for scrolling
                  if (docHighlightsRefs && !docHighlightsRefs.current[findingIdx]) {
                    docHighlightsRefs.current[findingIdx] = span;
                  }
                }
              });
            }
          }
        });
      }
    };

    renderPage();
  }, [page, scale, results, onFindingClick]);

  useEffect(() => {
    if (!textLayerRef.current) return;
    const marks = textLayerRef.current.querySelectorAll('.mark-highlight');
    marks.forEach(mark => {
      if (Number(mark.getAttribute('data-finding-idx')) === activeFindingIdx) {
        mark.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'scale-[1.02]', 'z-20', 'relative');
      } else {
        mark.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'scale-[1.02]', 'z-20', 'relative');
      }
    });
  }, [activeFindingIdx]);

  return (
    <div className="relative shadow-2xl mb-12 bg-white border border-slate-200 mx-auto group" 
         style={{ width: viewport?.width, height: viewport?.height }}>
      <style>{TEXT_LAYER_CSS}</style>
      <canvas ref={canvasRef} />
      <div ref={textLayerRef} className="textLayer" />
    </div>
  );
};

const Index = () => {
  const [text, setText] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState("");
  const [fileType, setFileType] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [activeFindingIdx, setActiveFindingIdx] = useState(null);
  const [zoom, setZoom] = useState(1.1);
  const [isDragActive, setIsDragActive] = useState(false);
  const [checkProgress, setCheckProgress] = useState(0);

  const findingsRefs = useRef([]);
  const docHighlightsRefs = useRef({});

  const { toast } = useToast();

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension !== 'pdf' && extension !== 'docx' && extension !== 'doc') {
      toast({ title: "Unsupported", description: "Only PDF, DOCX, and DOC files are supported.", variant: "destructive" });
      event.target.value = '';
      return;
    }

    setFileName(file.name);
    setFileType(extension);
    setIsUploading(true);
    setPdfDoc(null);
    setResult(null);

    try {
      const arrayBuffer = await file.arrayBuffer();

      if (extension === 'pdf') {
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);

        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const pageText = (await page.getTextContent()).items.map(item => item.str).join(' ');
          fullText += pageText + '\n';
        }
        setText(fullText);
      } else if (extension === 'docx') {
        const zip = await JSZip.loadAsync(arrayBuffer);
        const docXml = await zip.file("word/document.xml").async("text");
        
        // Split by page breaks to skip first 2 pages
        const pageBreaks = /<w:lastRenderedPageBreak\s*\/>|<w:br[^>]*w:type="page"[^>]*\/>/g;
        const pages = docXml.split(pageBreaks);
        
        let targetXml = docXml;
        if (pages.length > 2) {
          targetXml = pages.slice(2).join(" ");
        }
        
        // Extract paragraphs and text
        const paragraphsRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
        let fullText = "";
        let pMatch;
        while ((pMatch = paragraphsRegex.exec(targetXml)) !== null) {
          const pContent = pMatch[1];
          const textRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
          let tMatch;
          let pText = "";
          while ((tMatch = textRegex.exec(pContent)) !== null) {
            pText += tMatch[1];
          }
          if (pText.trim()) {
            fullText += pText + "\n";
          }
        }
        
        fullText = fullText.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        setText(fullText);
      } else if (extension === 'doc') {
        const formData = new FormData();
        formData.append("file", file);
        
        const response = await fetch("/api/extract-doc", {
          method: "POST",
          body: formData,
        });
        
        if (!response.ok) throw new Error("Failed to extract text from DOC");
        const data = await response.json();
        const docText = data.text;
        
        // Split by simple form feed / page break if present or just estimate
        const pages = docText.split(/\x0C/); // 0x0C is form feed (page break)
        if (pages.length > 2) {
          setText(pages.slice(2).join("\n"));
        } else {
          setText(docText);
        }
      }
    } catch (error) {
      console.error(error);
      toast({ title: "Error", description: `Failed to read ${extension.toUpperCase()} file`, variant: "destructive" });
    } finally {
      setIsUploading(false);
      setIsDragActive(false);
      if (event.target) event.target.value = '';
    }
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(true);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload({ target: { files: e.dataTransfer.files } });
    }
  };

  const handleCheck = async () => {
    if (!text.trim()) return;
    setIsChecking(true);
    setCheckProgress(0);
    setResult(null);
    try {
      const response = await fetch('/api/plagiarism-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!response.ok) {
        throw new Error("Server error: " + response.status);
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        // Keep the last incomplete line in buffer
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const data = JSON.parse(line);
              if (data.type === 'progress') {
                setCheckProgress(data.progress);
              } else if (data.type === 'complete') {
                setResult(data.result);
              } else if (data.type === 'error') {
                throw new Error(data.error);
              }
            } catch (e) {
              console.error("Error parsing streaming JSON", e);
            }
          }
        }
      }
    } catch (error) {
      toast({ title: "Analysis Failed", description: "The document might be too large or there was a server error.", variant: "destructive" });
    } finally {
      setIsChecking(false);
      setCheckProgress(0);
    }
  };

  const scrollToFinding = (idx) => {
    setActiveFindingIdx(idx);
    findingsRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const scrollToHighlight = (idx) => {
    setActiveFindingIdx(idx);
    docHighlightsRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };



  if (result) {
    const allFindings = result.results.filter(r => r.similarity >= 40);

    return (
      <div className="h-screen flex flex-col bg-slate-100 dark:bg-slate-950 overflow-hidden font-sans">
        {/* Header */}
        <header className="flex items-center justify-between px-8 py-4 border-b bg-white dark:bg-slate-900 shadow-sm z-10 shrink-0">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 mr-4 cursor-pointer" onClick={() => setResult(null)}>
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center text-white shadow-lg"><FileSearch className="w-5 h-5" /></div>
              <h1 className="text-xl font-black tracking-tighter uppercase italic hidden md:block">Guard<span className="text-primary">Text</span></h1>
            </div>
            <div className="flex items-center gap-3 border-l pl-6">
              <div>
                <h2 className="font-bold text-sm truncate max-w-[200px] leading-none mb-1">{fileName || "Analysis"}</h2>
                <div className="flex items-center gap-2">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">Similarity Score:</p>
                  <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${result.overallScore > 50 ? 'bg-red-100 text-red-600' : result.overallScore > 20 ? 'bg-orange-100 text-orange-600' : 'bg-green-100 text-green-600'}`}>
                    {result.overallScore}%
                  </span>
                </div>
              </div>
            </div>
          </div>
          
            <div className="flex items-center gap-4">
              <div className="flex items-center bg-slate-100 dark:bg-slate-800 rounded-lg p-1 mr-4">
                <Button variant="ghost" size="icon" onClick={() => setZoom(z => Math.max(0.5, z - 0.1))} className="h-8 w-8"><ZoomOut className="w-4 h-4" /></Button>
                <span className="text-[10px] font-black w-14 text-center">{Math.round(zoom * 100)}%</span>
                <Button variant="ghost" size="icon" onClick={() => setZoom(z => Math.min(3, z + 0.1))} className="h-8 w-8"><ZoomIn className="w-4 h-4" /></Button>
              </div>
              <Button onClick={() => setResult(null)} variant="default" className="font-bold px-8 rounded-full shadow-lg shadow-primary/20">New Analysis</Button>
            </div>
        </header>

        <main className="flex-1 overflow-hidden">
          <ResizablePanelGroup direction="horizontal">
            {/* Document Viewer */}
            <ResizablePanel defaultSize={75} minSize={30}>
              <div className="h-full bg-slate-200 dark:bg-slate-900 overflow-hidden flex flex-col">
                <ScrollArea className="flex-1 px-8 py-12">
                  <div className="flex flex-col items-center gap-8 pb-32">
                    {fileType === 'pdf' && pdfDoc ? (
                      Array.from({ length: pdfDoc.numPages }, (_, i) => (
                        <PdfPage 
                          key={i} 
                          page={pdfDoc.getPage(i + 1)} 
                          results={result.results} 
                          scale={zoom} 
                          activeFindingIdx={activeFindingIdx}
                          onFindingClick={scrollToFinding}
                          docHighlightsRefs={docHighlightsRefs}
                        />
                      ))
                    ) : (fileType === 'docx' || fileType === 'doc') ? (
                      <div className="w-full max-w-4xl mx-auto bg-white p-12 shadow-2xl border mb-12">
                         <div className="mb-8 p-4 bg-blue-50 border-l-4 border-blue-500 text-blue-700 font-medium">
                           {fileType.toUpperCase()} Viewer Mode - Note: First 2 pages (Introductory content) have been skipped.
                         </div>
                         <div className="space-y-4 text-lg leading-relaxed whitespace-pre-wrap">
                           {text.split('\n').map((paragraph, i) => {
                             if (!paragraph.trim()) return null;
                             // Very basic highlighting for docx text display based on results
                             let highlightedParagraph = <>{paragraph}</>;
                             if (result.results) {
                               const matches = result.results.filter(r => r.similarity >= 40 && paragraph.toLowerCase().includes(r.sentence.toLowerCase()));
                               if (matches.length > 0) {
                                  // For simplicity, just tint the paragraph if it has a match
                                  const maxSim = Math.max(...matches.map(m => m.similarity));
                                  let colorClass = "bg-yellow-200/50";
                                  if (maxSim > 50) colorClass = "bg-red-200/50";
                                  else if (maxSim > 25) colorClass = "bg-orange-200/50";
                                  
                                  highlightedParagraph = <span className={colorClass}>{paragraph}</span>;
                               }
                             }
                             return <p key={i}>{highlightedParagraph}</p>;
                           })}
                         </div>
                      </div>
                    ) : (
                      <div className="w-full h-96 flex items-center justify-center text-muted-foreground">
                        No Document loaded.
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Sidebar Findings */}
            <ResizablePanel defaultSize={25} minSize={20}>
              <div className="h-full flex flex-col bg-white dark:bg-slate-950 border-l shadow-2xl z-10">
                <div className="px-6 py-5 bg-slate-50 dark:bg-slate-900 border-b">
                  <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-red-500" />
                    Matched Sources
                  </h3>
                  <p className="text-[10px] text-muted-foreground font-bold mt-1 uppercase tracking-tighter">Click to locate in document</p>
                </div>
                <ScrollArea className="flex-1">
                  <div className="p-4 space-y-4">
                    {allFindings.length === 0 ? (
                      <div className="py-20 text-center px-4 opacity-50">
                        <FileSearch className="w-12 h-12 mx-auto mb-4 text-slate-300" />
                        <p className="text-sm font-bold">No Significant Matches</p>
                      </div>
                    ) : (
                      allFindings.map((item, index) => {
                        const similarity = item.similarity;
                        let colorClass = "border-yellow-500 bg-yellow-50/50";
                        let textColor = "text-yellow-700";
                        let badgeClass = "bg-yellow-100 text-yellow-700";
                        
                        if (similarity > 50) {
                          colorClass = "border-red-500 bg-red-50/50";
                          textColor = "text-red-700";
                          badgeClass = "bg-red-100 text-red-700";
                        } else if (similarity > 25) {
                          colorClass = "border-orange-500 bg-orange-50/50";
                          textColor = "text-orange-700";
                          badgeClass = "bg-orange-100 text-orange-700";
                        }

                        return (
                          <Card 
                            key={index} 
                            ref={el => findingsRefs.current[index] = el}
                            onClick={() => scrollToHighlight(index)}
                            className={`cursor-pointer overflow-hidden border-none shadow-sm transition-all duration-300 ${activeFindingIdx === index ? 'ring-2 ring-primary scale-[1.02] bg-primary/5' : 'hover:bg-white hover:shadow-md'}`}
                          >
                            <CardContent className="p-4 space-y-3">
                              <p className={`text-xs font-semibold italic leading-relaxed border-l-4 pl-3 ${colorClass} ${textColor}`}>"{item.sentence}"</p>
                              <div className="flex justify-between items-center text-[10px] font-black uppercase">
                                <span className={`${badgeClass} px-1.5 py-0.5 rounded`}>{similarity}% match</span>
                                <a href={item.sources[0]?.url} onClick={e => e.stopPropagation()} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1">Source <ExternalLink className="w-2.5 h-2.5" /></a>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })
                    )}
                  </div>
                </ScrollArea>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </main>
      </div>
    );
  }

  return <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col font-sans">
    {/* Landing */}
    <header className="px-12 py-8 flex justify-between items-center bg-white border-b sticky top-0 z-50">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 bg-primary rounded-2xl flex items-center justify-center text-white shadow-xl shadow-primary/20"><FileSearch className="w-7 h-7" /></div>
        <h1 className="text-2xl font-black tracking-tighter uppercase italic">Guard<span className="text-primary">Text</span></h1>
      </div>
      <Button variant="ghost" className="font-bold uppercase tracking-widest text-xs">Sign In</Button>
    </header>

    {/* Progress Overlay */}
    {isChecking && (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center animate-in fade-in duration-300">
        <Card className="w-full max-w-md p-8 shadow-2xl border-none rounded-[32px] bg-white text-center space-y-6">
          <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-primary">
            <Loader2 className="w-10 h-10 animate-spin" />
          </div>
          <div className="space-y-2">
            <h3 className="text-2xl font-black tracking-tight text-slate-900">Scanning Document</h3>
            <p className="text-slate-500 font-medium">Checking billions of sources across the web...</p>
          </div>
          <div className="space-y-2">
            <Progress value={checkProgress} className="h-3 bg-slate-100" indicatorClassName="bg-primary transition-all duration-300" />
            <div className="flex justify-between text-xs font-bold text-slate-500 uppercase tracking-widest">
              <span>{checkProgress}% Complete</span>
              <span>{100 - checkProgress}% Remaining</span>
            </div>
          </div>
        </Card>
      </div>
    )}

    <div className="flex-1 flex items-center justify-center p-12 bg-slate-50">
      <div className="w-full max-w-2xl">
        <Card className="shadow-2xl border-none p-12 bg-white rounded-[48px]">
          <div className="space-y-10">
            <div className="text-center space-y-4">
              <h2 className="text-5xl font-black tracking-tight leading-tight">Professional <span className="text-primary">Plagiarism</span> Analysis</h2>
              <p className="text-lg text-muted-foreground font-medium max-w-lg mx-auto leading-relaxed">High-fidelity visualization for academic and professional documents.</p>
            </div>

            {!fileName ? (
              <div 
                className="relative group"
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                <input type="file" accept=".pdf,.docx,.doc" onChange={handleFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" disabled={isUploading} />
                <div className={`border-4 border-dashed rounded-[40px] p-24 transition-all flex flex-col items-center gap-8 ${isDragActive ? 'border-primary bg-primary/10' : 'border-slate-100 group-hover:border-primary/20 group-hover:bg-primary/5'}`}>
                  <div className={`w-24 h-24 rounded-[32px] bg-white shadow-2xl flex items-center justify-center text-primary transition-transform duration-500 ${isDragActive ? 'scale-110' : 'group-hover:scale-110'}`}>
                    {isUploading ? <Loader2 className="w-12 h-12 animate-spin" /> : <Upload className="w-12 h-12" />}
                  </div>
                  <div className="text-center space-y-2">
                    <p className="font-black text-2xl tracking-tight">{isUploading ? "Reading File..." : isDragActive ? "Drop File Now" : "Drop Document Here"}</p>
                    <p className="text-sm text-muted-foreground font-bold uppercase tracking-widest">Supports PDF, DOCX, and DOC</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-8 animate-in zoom-in-95 duration-500">
                <div className="flex items-center gap-6 p-8 bg-primary/5 border-2 border-primary/20 rounded-[32px]">
                  <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center text-primary shadow-inner"><FileText className="w-10 h-10" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-2xl font-black truncate leading-tight">{fileName}</p>
                    <p className="text-xs text-muted-foreground font-black uppercase tracking-widest mt-1">Ready for scan • {fileType.toUpperCase()}</p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => setFileName("")} className="rounded-full h-12 w-12 hover:bg-red-50 hover:text-red-500"><X className="w-6 h-6" /></Button>
                </div>
                <Button onClick={handleCheck} disabled={isChecking} className="w-full h-20 text-xl font-black rounded-3xl shadow-2xl shadow-primary/30 transition-transform active:scale-[0.98]">
                  {isChecking ? <><Loader2 className="mr-3 h-6 w-6 animate-spin" /> Analyzing Content...</> : "Start Analysis"}
                </Button>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  </div>;
};

export default Index;